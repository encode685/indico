// This file is part of Indico.
// Copyright (C) 2002 - 2024 CERN
//
// Indico is free software; you can redistribute it and/or
// modify it under the terms of the MIT License; see the
// LICENSE file for more details.

/* global handleAjaxError:false, ajaxDialog:false */

import {Calendar} from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import moment from 'moment';
import React from 'react';
import ReactDOM from 'react-dom';

import {CalendarSingleDatePicker} from 'indico/react/components';
import {Translate} from 'indico/react/i18n';
import {injectModal} from 'indico/react/util';
import {$T} from 'indico/utils/i18n';

import CalendarLegend from './components/CalendarLegend';

(function(global) {
  let groupBy = 'category';
  const filteredLegendElements = new Set();
  let closeCalendar = null;
  let ignoreClick = false;
  global.setupCategoryCalendar = function setupCategoryCalendar(
    containerCalendarSelector,
    containerLegendSelector,
    tz,
    categoryURL,
    categoryId
  ) {
    const cachedEvents = {};
    const container = document.querySelector(containerCalendarSelector);
    const calendar = new Calendar(container, {
      headerToolbar: {
        start: 'prev,next goToDate today',
        center: 'title',
        end: 'dayGridMonth,dayGridWeek,dayGridDay',
      },
      customButtons: {
        goToDate: {
          text: Translate.string('Go to...'),
          icon: 'i-button icon-calendar',
          click: async (_, element) => {
            if (ignoreClick) {
              ignoreClick = false;
              return;
            }
            if (closeCalendar) {
              closeCalendar();
              return;
            }
            const button = element.closest('button');
            const rect = button.getBoundingClientRect();
            const position = {
              left: rect.left,
              top: rect.bottom + 10,
            };
            closeCalendar = (resolve, evt = undefined) => {
              closeCalendar = null;
              resolve();
              if (evt && button.contains(evt.target)) {
                // if the calendar was closed by clicking again on the button, we have to
                // ignore that click event to avoid opening it again immediately
                ignoreClick = true;
              }
            };
            await injectModal(
              resolve => (
                <CalendarSingleDatePicker
                  date={moment(calendar.getDate())}
                  onDateChange={date => calendar.gotoDate(date.toDate())}
                  onOutsideClick={evt => closeCalendar(resolve, evt)}
                  onClose={() => closeCalendar(resolve)}
                  isOutsideRange={() => false}
                  numberOfMonths={1}
                />
              ),
              position
            );
          },
        },
      },
      plugins: [dayGridPlugin],
      initialView: 'dayGridMonth',
      timeZone: tz,
      firstDay: 1,
      height: 850,
      eventOrder: 'start',
      eventTextColor: '#FFF',
      eventTimeFormat: {
        // most convoluted way of writing HH:MM...
        hour: '2-digit',
        minute: '2-digit',
        meridiem: false,
        hour12: false,
      },
      nextDayThreshold: '00:00',
      dayMaxEvents: true,
      buttonText: {
        today: $T.gettext('Today'),
      },
      events({start, end}, successCallback, failureCallback) {
        function updateCalendar(data) {
          const attr = {category: 'categoryId', location: 'venueId', room: 'roomId'}[groupBy];
          if (!attr) {
            throw new Error(`Invalid "groupBy": ${groupBy}`);
          }
          const filteredEvents = data.events.filter(e => !filteredLegendElements.has(e[attr] ?? 0));
          successCallback(filteredEvents);
          const toolbarGroup = $(containerCalendarSelector).find(
            '.fc-toolbar .fc-toolbar-chunk:last-child'
          );
          const ongoingEventsInfo = $('<a>', {
            href: '#',
            class: 'ongoing-events-info',
            text: $T
              .ngettext(
                '{0} long-lasting event not shown',
                '{0} long-lasting events not shown',
                data.ongoing_event_count
              )
              .format(data.ongoing_event_count),
            on: {
              click: evt => {
                evt.preventDefault();
                ajaxDialog({
                  title: $T.gettext('Long lasting events'),
                  content: $(data.ongoing_events_html),
                  dialogClasses: 'ongoing-events-dialog',
                });
              },
            },
          });

          toolbarGroup.find('.ongoing-events-info').remove();
          if (data.ongoing_event_count) {
            toolbarGroup.prepend(ongoingEventsInfo);
          }
        }

        function setupCalendarLegend(data, items, legendContainer) {
          const onFilterChanged = filterBy => {
            groupBy = filterBy;
            filteredLegendElements.clear();
            calendar.refetchEvents();
          };
          const onElementSelected = (elementId, checked, elementSubitems, parent) => {
            const handleSingle = (singleId, singleChecked) => {
              if (singleChecked) {
                filteredLegendElements.delete(singleId);
              } else {
                filteredLegendElements.add(singleId);
              }
            };
            const handleRecursive = (recursiveId, recursiveSubitems) => {
              handleSingle(recursiveId, checked);
              recursiveSubitems.forEach(({id, subitems}) => handleRecursive(id, subitems));
            };

            // handle descendents
            handleRecursive(elementId, elementSubitems);

            // handle parent
            if (parent) {
              const parentChecked = !parent.subitems.every(({id}) =>
                filteredLegendElements.has(id)
              );
              handleSingle(parent.id, parentChecked);
            }

            calendar.refetchEvents();
          };
          const selectAll = () => {
            items.forEach(({id, subitems}) => onElementSelected(id, true, subitems));
            calendar.refetchEvents();
          };
          const deselectAll = () => {
            items.forEach(({id, subitems}) => onElementSelected(id, false, subitems));
            calendar.refetchEvents();
          };
          const filterLegendElement = item => {
            item.checked = !filteredLegendElements.has(item.id);
            item.subitems.forEach(filterLegendElement);
          };
          items.forEach(filterLegendElement);
          ReactDOM.render(
            <CalendarLegend
              items={items}
              groupBy={data.group_by}
              onFilterChanged={onFilterChanged}
              onElementSelected={onElementSelected}
              selectAll={selectAll}
              deselectAll={deselectAll}
            />,
            legendContainer
          );
        }

        function setupLegendByAttribute({
          events,
          items,
          attr,
          defaultTitle,
          rootId,
          rootTitle = undefined,
          sortMethod = undefined,
        }) {
          const itemMap = items.reduce(
            (acc, {id, title, url}) => ({
              ...acc,
              [id]: {title: title ?? defaultTitle, url},
            }),
            {}
          );
          const usedItems = new Set();
          return events
            .reduce((acc, value) => {
              const id = value[attr] ?? 0;
              if (usedItems.has(id)) {
                return acc;
              }
              usedItems.add(id);
              const item = itemMap[id] ?? {};
              const isSpecial = id === rootId;
              return [
                ...acc,
                {
                  title: (isSpecial ? rootTitle : item.title) ?? defaultTitle,
                  color: value.color,
                  url: item.url,
                  isSpecial,
                  id,
                  subitems: [],
                  parent: null,
                },
              ];
            }, [])
            .sort((a, b) => {
              if (a.isSpecial) {
                return -1;
              } else if (b.isSpecial) {
                return 1;
              }
              return sortMethod ? sortMethod(a.title, b.title) : a.title.localeCompare(b.title);
            });
        }

        function setupLegendByRoom(events, locations, rooms) {
          const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
          const result = setupLegendByAttribute({
            events,
            items: rooms,
            attr: 'roomId',
            defaultTitle: Translate.string('No room'),
            rootId: 0,
            rootTitle: Translate.string('No room'),
            sortMethod: collator.compare,
          });
          // if there are no locations no need to indent
          if (locations.length <= 1) {
            return result;
          }
          const roomMap = rooms.reduce(
            (acc, value) => ({
              ...acc,
              [value.id]: value,
            }),
            {}
          );
          const locationMap = locations.reduce(
            (acc, value) => ({
              ...acc,
              [value.id]: value,
            }),
            {}
          );
          const groupedLocations = {};
          const noRoom = [];
          result.forEach(item => {
            const room = roomMap[item.id];
            if (!room) {
              // this is the "No room" case
              noRoom.push(item);
            } else {
              const location = locationMap[room.venueId];
              if (!groupedLocations[location.id]) {
                groupedLocations[location.id] = {
                  // we make the ID negative in order not to collide with room IDs
                  id: -location.id,
                  title: location.title,
                  isSpecial: false,
                  subitems: [],
                  parent: null,
                };
              }
              groupedLocations[location.id].subitems.push({
                ...item,
                parent: groupedLocations[location.id],
              });
            }
          });
          return [...noRoom, ...Object.values(groupedLocations)];
        }

        function updateLegend(data) {
          let items;
          switch (data.group_by) {
            case 'category':
              items = setupLegendByAttribute({
                events: data.events,
                items: data.categories,
                attr: 'categoryId',
                defaultTitle: Translate.string('No category'),
                rootId: categoryId,
                rootTitle: Translate.string('This category'),
              });
              break;
            case 'location':
              items = setupLegendByAttribute({
                events: data.events,
                items: data.locations,
                attr: 'venueId',
                defaultTitle: Translate.string('No venue'),
                rootId: 0,
              });
              break;
            case 'room':
              items = setupLegendByRoom(data.events, data.locations, data.rooms);
              break;
            default:
              items = [];
              break;
          }
          setupCalendarLegend(data, items, document.getElementById(containerLegendSelector));
        }

        start = start.toISOString().substring(0, 10);
        end = end.toISOString().substring(0, 10);
        const key = `${start}-${end}-${groupBy}`;
        if (cachedEvents[key]) {
          updateLegend(cachedEvents[key]);
          updateCalendar(cachedEvents[key]);
        } else {
          $.ajax({
            url: categoryURL,
            data: {start, end, group_by: groupBy},
            dataType: 'json',
            contentType: 'application/json',
            complete: IndicoUI.Dialogs.Util.progress(),
            success(data) {
              updateLegend(data);
              updateCalendar(data);
              cachedEvents[key] = data;
            },
            error(error) {
              failureCallback(new Error('Loading events failed'));
              handleAjaxError(error);
            },
          });
        }
      },
    });
    calendar.render();
  };
})(window);
