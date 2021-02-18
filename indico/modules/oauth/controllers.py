# This file is part of Indico.
# Copyright (C) 2002 - 2021 CERN
#
# Indico is free software; you can redistribute it and/or
# modify it under the terms of the MIT License; see the
# LICENSE file for more details.

from authlib.oauth2.base import OAuth2Error
from authlib.oauth2.rfc6749 import scope_to_list
from authlib.oauth2.rfc8414 import AuthorizationServerMetadata
from flask import flash, jsonify, redirect, render_template, request, session
from werkzeug.exceptions import Forbidden

from indico.core.config import config
from indico.core.db import db
from indico.modules.admin import RHAdminBase
from indico.modules.oauth import logger
from indico.modules.oauth.forms import ApplicationForm
from indico.modules.oauth.models.applications import SCOPES, OAuthApplication
from indico.modules.oauth.models.tokens import OAuthToken
from indico.modules.oauth.oauth2 import (IndicoAuthorizationCodeGrant, IndicoCodeChallenge, IndicoIntrospectionEndpoint,
                                         authorization)
from indico.modules.oauth.views import WPOAuthAdmin, WPOAuthUserProfile
from indico.modules.users.controllers import RHUserBase
from indico.util.i18n import _
from indico.web.flask.util import url_for
from indico.web.forms.base import FormDefaults
from indico.web.rh import RH, RHProtected


class RHOAuthMetadata(RH):
    """Return RFC8414 Authorization Server Metadata."""

    def _process(self):
        metadata = AuthorizationServerMetadata(
            authorization_endpoint=url_for('.oauth_authorize', _external=True),
            token_endpoint=url_for('.oauth_token', _external=True),
            introspection_endpoint=url_for('.oauth_introspect', _external=True),
            issuer=config.BASE_URL,
            response_types_supported=['code'],
            response_modes_supported=['query'],
            grant_types_supported=['authorization_code'],
            scopes_supported=list(SCOPES),
            token_endpoint_auth_methods_supported=list(IndicoAuthorizationCodeGrant.TOKEN_ENDPOINT_AUTH_METHODS),
            introspection_endpoint_auth_methods_supported=list(IndicoIntrospectionEndpoint.CLIENT_AUTH_METHODS),
            code_challenge_methods_supported=list(IndicoCodeChallenge.SUPPORTED_CODE_CHALLENGE_METHOD),
        )
        metadata.validate()
        return jsonify(metadata)


class RHOAuthAuthorize(RHProtected):
    CSRF_ENABLED = False

    def _process(self):
        rv = self._process_consent()
        if rv is True:
            return authorization.create_authorization_response(grant_user=session.user)
        elif rv is False:
            return authorization.create_authorization_response(grant_user=None)
        else:
            return rv

    def _process_consent(self):
        try:
            grant = authorization.get_consent_grant(end_user=session.user)
        except OAuth2Error as error:
            return render_template('oauth/authorize_errors.html', error=error.error)

        application = grant.client

        if request.method == 'POST':
            if 'confirm' not in request.form:
                return False
            logger.info('User %s authorized %s', session.user, application)
            return True
        elif application.is_trusted:
            logger.info('User %s automatically authorized %s', session.user, application)
            return True

        # TODO: get the combined scopes of all tokens if we allow multiple tokens
        token = application.tokens.filter_by(user=session.user).first()
        authorized_scopes = token.scopes if token else set()
        requested_scopes = set(scope_to_list(grant.request.scope)) if grant.request.scope else authorized_scopes
        if requested_scopes <= authorized_scopes:
            return True

        new_scopes = requested_scopes - authorized_scopes
        return render_template('oauth/authorize.html', application=application,
                               authorized_scopes=[_f for _f in [SCOPES.get(s) for s in authorized_scopes] if _f],
                               new_scopes=[_f for _f in [SCOPES.get(s) for s in new_scopes] if _f])


class RHOAuthToken(RH):
    CSRF_ENABLED = False

    def _process(self):
        resp = authorization.create_token_response()
        resp.headers['Access-Control-Allow-Methods'] = 'POST'
        resp.headers['Access-Control-Allow-Origin'] = '*'
        return resp


class RHOAuthIntrospect(RH):
    CSRF_ENABLED = False

    def _process(self):
        return authorization.create_endpoint_response('introspection')


class RHOAuthAdmin(RHAdminBase):
    """OAuth server administration settings."""

    def _process(self):
        applications = OAuthApplication.query.order_by(db.func.lower(OAuthApplication.name)).all()
        return WPOAuthAdmin.render_template('apps.html', applications=applications)


class RHOAuthAdminApplicationBase(RHAdminBase):
    """Base class for single OAuth application RHs."""
    def _process_args(self):
        self.application = OAuthApplication.get_or_404(request.view_args['id'])


class RHOAuthAdminApplication(RHOAuthAdminApplicationBase):
    """Handle application details page."""

    def _process(self):
        form = ApplicationForm(obj=self.application, application=self.application)
        disabled_fields = set(self.application.system_app_type.enforced_data)
        if form.validate_on_submit():
            form.populate_obj(self.application)
            logger.info("Application %s updated by %s", self.application, session.user)
            flash(_("Application {} was modified").format(self.application.name), 'success')
            return redirect(url_for('.apps'))
        return WPOAuthAdmin.render_template('app_details.html', application=self.application, form=form,
                                            disabled_fields=disabled_fields)


class RHOAuthAdminApplicationDelete(RHOAuthAdminApplicationBase):
    """Handle OAuth application deletion."""

    def _check_access(self):
        RHOAuthAdminApplicationBase._check_access(self)
        if self.application.system_app_type:
            raise Forbidden('Cannot delete system app')

    def _process(self):
        db.session.delete(self.application)
        logger.info("Application %s deleted by %s", self.application, session.user)
        flash(_("Application deleted successfully"), 'success')
        return redirect(url_for('.apps'))


class RHOAuthAdminApplicationNew(RHAdminBase):
    """Handle OAuth application registration."""

    def _process(self):
        form = ApplicationForm(obj=FormDefaults(is_enabled=True))
        if form.validate_on_submit():
            application = OAuthApplication()
            form.populate_obj(application)
            db.session.add(application)
            db.session.flush()
            logger.info("Application %s created by %s", application, session.user)
            flash(_("Application {} registered successfully").format(application.name), 'success')
            return redirect(url_for('.app_details', application))
        return WPOAuthAdmin.render_template('app_new.html', form=form)


class RHOAuthAdminApplicationReset(RHOAuthAdminApplicationBase):
    """Reset the client secret of the OAuth application."""

    def _process(self):
        self.application.reset_client_secret()
        logger.info("Client secret of %s reset by %s", self.application, session.user)
        flash(_("New client secret generated for the application"), 'success')
        return redirect(url_for('.app_details', self.application))


class RHOAuthAdminApplicationRevoke(RHOAuthAdminApplicationBase):
    """Revoke all user tokens associated to the OAuth application."""

    def _process(self):
        self.application.tokens.delete()
        logger.info("All user tokens for %s revoked by %s", self.application, session.user)
        flash(_("All user tokens for this application were revoked successfully"), 'success')
        return redirect(url_for('.app_details', self.application))


class RHOAuthUserProfile(RHUserBase):
    """OAuth overview (user)."""

    def _process(self):
        tokens = self.user.oauth_tokens.all()
        return WPOAuthUserProfile.render_template('user_profile.html', 'applications', user=self.user, tokens=tokens)


class RHOAuthUserTokenRevoke(RHUserBase):
    """Revoke user token."""

    def _process_args(self):
        RHUserBase._process_args(self)
        self.token = OAuthToken.get(request.view_args['id'])
        if self.user != self.token.user:
            raise Forbidden("You can only revoke tokens associated with your user")

    def _process(self):
        db.session.delete(self.token)
        logger.info("Token of application %s for user %s was revoked.", self.token.application, self.token.user)
        flash(_("Token for {} has been revoked successfully").format(self.token.application.name), 'success')
        return redirect(url_for('.user_profile'))
