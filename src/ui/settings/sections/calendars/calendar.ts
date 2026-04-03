/**
 * @file calendar.ts
 * @brief A wrapper for initializing and rendering the FullCalendar.js library.
 *
 * @description
 * This file provides the `renderCalendar` function, which is a factory for
 * creating a `Calendar` instance from the `@fullcalendar/core` library. It
 * encapsulates all the configuration and boilerplate needed to set up the
 * calendar, including plugins, views, toolbar settings, and interaction
 * callbacks.
 *
 * @exports renderCalendar
 *
 * @license See LICENSE.md
 */

import type {
  Calendar,
  EventApi,
  EventClickArg,
  EventHoveringArg,
  EventSourceInput,
  LocaleInput
} from '@fullcalendar/core';
import csLocale from '@fullcalendar/core/locales/cs';

import { Menu } from 'obsidian';
import type { PluginDef } from '@fullcalendar/core';
import { createDateNavigation } from '../../../../features/navigation/DateNavigation';
import {
  patchRRuleTimezoneExpansion,
  type RRulePluginLike
} from '../../../../features/timezone/Timezone';

interface ExtraRenderProps {
  eventClick?: (info: EventClickArg) => void;
  customButtons?: {
    [key: string]: {
      text: string;
      click: (ev?: MouseEvent) => void | Promise<void>;
    };
  };

  select?: (startDate: Date, endDate: Date, allDay: boolean, viewType: string) => Promise<void>;
  modifyEvent?: (event: EventApi, oldEvent: EventApi, newResource?: string) => Promise<boolean>;
  eventMouseEnter?: (info: EventHoveringArg) => void;
  firstDay?: number;
  locale?: string;
  initialView?: { desktop: string; mobile: string };
  timeFormat24h?: boolean;
  openContextMenuForEvent?: (event: EventApi, mouseEvent: MouseEvent) => Promise<void>;
  toggleTask?: (event: EventApi, isComplete: boolean) => Promise<boolean>;
  dateRightClick?: (date: Date, mouseEvent: MouseEvent) => void;
  viewRightClick?: (mouseEvent: MouseEvent, calendar: Calendar) => void;
  forceNarrow?: boolean;
  resources?: { id: string; title: string; eventColor?: string }[];
  onViewChange?: () => void; // Add view change callback
  businessHours?: boolean | object; // Support for business hours
  drop?: (taskId: string, date: Date) => Promise<void>; // Drag-and-drop from backlog
  timeZone?: string;

  // New granular view configuration properties
  slotMinTime?: string;
  slotMaxTime?: string;
  weekends?: boolean;
  hiddenDays?: number[];
  dayMaxEvents?: number | boolean;
}

export async function renderCalendar(
  containerEl: HTMLElement,
  eventSources: EventSourceInput[],
  settings?: ExtraRenderProps & { enableAdvancedCategorization?: boolean }
): Promise<Calendar> {
  // Lazy-load FullCalendar core and plugins only when rendering
  const [core, list, rrule, daygrid, timegrid, interaction, luxon] = await Promise.all([
    import('@fullcalendar/core'),
    import('@fullcalendar/list'),
    import('@fullcalendar/rrule'),
    import('@fullcalendar/daygrid'),
    import('@fullcalendar/timegrid'),
    import('@fullcalendar/interaction'),
    import('@fullcalendar/luxon3')
  ]);

  // Optionally load scheduler plugin only when needed
  const showResourceViews = !!settings?.enableAdvancedCategorization;
  const resourceTimeline = showResourceViews
    ? await import('@fullcalendar/resource-timeline')
    : null;

  const isMobile = window.innerWidth < 500;
  const isNarrow = settings?.forceNarrow || isMobile;

  // Apply RRULE monkeypatch on every render to capture the latest settings.timeZone.
  // We apply the extracted logic from Timezone.ts to safely handle DST offsets.
  {
    const rrulePlugin = ((rrule as unknown as { default?: RRulePluginLike }).default ||
      rrule) as unknown as RRulePluginLike;

    patchRRuleTimezoneExpansion(rrulePlugin, settings?.timeZone);
  }

  const {
    eventClick,
    select,
    modifyEvent,
    eventMouseEnter,
    openContextMenuForEvent,
    toggleTask,
    dateRightClick,
    viewRightClick,
    customButtons,
    resources,
    onViewChange,
    businessHours,
    drop
  } = settings || {};

  // Wrap eventClick to ignore shadow events
  const wrappedEventClick =
    eventClick &&
    ((info: EventClickArg) => {
      // Ignore clicks on shadow events
      if (info.event.extendedProps.isShadow) {
        return;
      }
      return eventClick(info);
    });
  const modifyEventCallback =
    modifyEvent &&
    (({
      event,
      oldEvent,
      revert,
      newResource
    }: {
      event: EventApi;
      oldEvent: EventApi;
      revert: () => void;
      newResource?: { id: string };
    }): void => {
      void (async () => {
        // Extract the string ID from the newResource object
        const success = await modifyEvent(event, oldEvent, newResource?.id);
        if (!success) {
          revert();
        }
      })();
    });

  // Group the standard and timeline views together with a space.
  // This tells FullCalendar to render them as a single, connected button group.
  const viewButtonGroup = ['views', showResourceViews ? 'timeline' : null]
    .filter(Boolean)
    .join(',');

  // The comma between 'analysis' and the view group creates the visual separation.
  const rightToolbarGroup = [!isNarrow ? 'analysis' : null, viewButtonGroup]
    .filter(Boolean)
    .join(' ');

  const headerToolbar = !isNarrow
    ? {
        left: 'workspace today prevMonth,monthNav,nextMonth prevYear,yearNav,nextYear',
        center: 'title',
        right: rightToolbarGroup
      }
    : false;

  const footerToolbar = false;

  type ViewSpec = {
    type: string;
    duration?: { days?: number; weeks?: number };
    buttonText: string;
    slotMinWidth?: number;
  };
  const views: Record<string, ViewSpec> = {
    timeGridDay: {
      type: 'timeGrid',
      duration: { days: 1 },
      buttonText: isNarrow ? '1' : 'day'
    },
    timeGrid3Days: {
      type: 'timeGrid',
      duration: { days: 3 },
      buttonText: '3'
    }
  };
  if (showResourceViews) {
    views.resourceTimelineDay = {
      type: 'resourceTimeline',
      duration: { days: 1 },
      buttonText: 'Timeline day'
    };
    views.resourceTimelineWeek = {
      type: 'resourceTimeline',
      duration: { weeks: 1 },
      buttonText: 'Timeline week',
      slotMinWidth: 100
    };
  }

  const customButtonConfig: Record<string, { text: string; click: (ev: MouseEvent) => void }> =
    Object.assign({}, customButtons);

  // Always add the "Views" dropdown
  customButtonConfig.views = {
    text: 'View ▾',
    click: (ev: MouseEvent) => {
      const menu = new Menu();

      const views = isNarrow
        ? {
            dayGridMonth: 'Month',
            timeGrid3Days: '3 Days',
            timeGridDay: 'Day',
            listWeek: 'List'
          }
        : {
            dayGridMonth: 'Month',
            timeGridWeek: 'Week',
            timeGridDay: 'Day',
            listWeek: 'List'
          };

      for (const [viewName, viewLabel] of Object.entries(views) as [string, string][]) {
        menu.addItem(item =>
          item.setTitle(viewLabel).onClick(() => {
            cal.changeView(viewName);
          })
        );
      }
      menu.showAtMouseEvent(ev);
    }
  };

  // Month/year navigation buttons (handlers wired after render)
  customButtonConfig.prevMonth = { text: '◀', click: () => {} };
  customButtonConfig.monthNav = { text: '···', click: () => {} };
  customButtonConfig.nextMonth = { text: '▶', click: () => {} };
  customButtonConfig.prevYear = { text: '«', click: () => {} };
  customButtonConfig.yearNav = { text: '····', click: () => {} };
  customButtonConfig.nextYear = { text: '»', click: () => {} };

  // Conditionally add the "Timeline" dropdown
  if (showResourceViews) {
    customButtonConfig.timeline = {
      text: 'Timeline ▾',
      click: (ev: MouseEvent) => {
        const menu = new Menu();
        menu.addItem(item =>
          item.setTitle('Timeline week').onClick(() => {
            cal.changeView('resourceTimelineWeek');
          })
        );
        menu.addItem(item =>
          item.setTitle('Timeline day').onClick(() => {
            cal.changeView('resourceTimelineDay');
          })
        );
        menu.showAtMouseEvent(ev);
      }
    };
  }

  // FullCalendar Premium open-source license key (GPLv3 projects)
  // See: https://fullcalendar.io/license for details
  // Narrow dynamic imports to expected shapes without pervasive any usage.
  const CalendarCtor = (core as { Calendar: typeof Calendar }).Calendar;
  const dayGridPlugin = (daygrid as { default: PluginDef }).default;
  const timeGridPlugin = (timegrid as { default: PluginDef }).default;
  const listPlugin = (list as { default: PluginDef }).default;
  const rrulePlugin = (rrule as { default: PluginDef }).default;
  const interactionPlugin = (interaction as { default: PluginDef }).default;
  const luxonPlugin = (luxon as { default: PluginDef }).default;
  const resourceTimelinePlugin = resourceTimeline
    ? (resourceTimeline as { default: PluginDef }).default
    : null;

  const cal = new CalendarCtor(containerEl, {
    // Only include schedulerLicenseKey when resource-timeline plugin is loaded
    ...(showResourceViews && resourceTimelinePlugin
      ? { schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source' }
      : {}),
    customButtons: customButtonConfig,
    timeZone: settings?.timeZone,
    plugins: [
      // View plugins
      dayGridPlugin,
      timeGridPlugin,
      listPlugin,
      // Only include the heavy scheduler plugin when needed
      ...(showResourceViews && resourceTimelinePlugin
        ? ([resourceTimelinePlugin] as const)
        : ([] as const)),
      // Drag + drop and editing
      interactionPlugin,
      rrulePlugin,
      luxonPlugin
    ],
    initialView:
      settings?.initialView?.[isNarrow ? 'mobile' : 'desktop'] ||
      (isNarrow ? 'timeGrid3Days' : 'timeGridWeek'),
    nowIndicator: true,
    scrollTimeReset: false,
    dayMaxEvents: settings?.dayMaxEvents !== undefined ? settings.dayMaxEvents : true, // Use setting override or default to true
    headerToolbar,
    footerToolbar,
    // Cast at usage point to satisfy FullCalendar without polluting variable with any
    views,
    ...(showResourceViews && {
      resourceAreaHeaderContent: 'Categories',
      resources,
      resourcesInitiallyExpanded: false
    }),

    // Business hours configuration
    ...(businessHours && { businessHours }),

    eventAllow: (dropInfo, draggedEvent) => {
      // dropInfo.resource is the resource that the event is being dropped on
      const resource = (dropInfo as { resource?: { extendedProps?: { isParent?: boolean } } })
        .resource;
      if (resource?.extendedProps?.isParent) {
        return false; // Disallow drop on parent
      }
      return true; // Allow drop on children (or in non-resource views)
    },

    firstDay: settings?.firstDay,
    ...(settings?.locale && {
      locales: [csLocale] as LocaleInput[],
      locale: settings.locale
    }),
    // New granular view configuration settings
    ...(settings?.slotMinTime !== undefined && { slotMinTime: settings.slotMinTime }),
    ...(settings?.slotMaxTime !== undefined && { slotMaxTime: settings.slotMaxTime }),
    ...(settings?.weekends !== undefined && { weekends: settings.weekends }),
    ...(settings?.hiddenDays !== undefined && { hiddenDays: settings.hiddenDays }),
    ...(settings?.timeFormat24h && {
      eventTimeFormat: {
        hour: 'numeric',
        minute: '2-digit',
        hour12: false
      },
      slotLabelFormat: {
        hour: 'numeric',
        minute: '2-digit',
        hour12: false
      }
    }),
    eventSources,
    eventClick: wrappedEventClick,

    selectable: select && true,
    selectMirror: select && true,
    select:
      select &&
      ((info): void => {
        void (async () => {
          await select(info.start, info.end, info.allDay, info.view.type);
          info.view.calendar.unselect();
        })();
      }),

    // Handle date clicks (including right-clicks for navigation menu)
    dateClick: info => {
      // Only handle right-clicks for date navigation
      if (info.jsEvent.button === 2 && dateRightClick) {
        info.jsEvent.preventDefault();
        dateRightClick(info.date, info.jsEvent);
      }
    },

    editable: modifyEvent && true,
    eventDrop: modifyEventCallback,
    eventResize: modifyEventCallback,

    eventMouseEnter,

    eventDidMount: ({ event, el, textColor }) => {
      // Don't add context menu or checkboxes to shadow events
      if (event.extendedProps.isShadow) {
        el.addClass('fc-event-shadow');
        return;
      }

      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (openContextMenuForEvent) {
          void openContextMenuForEvent(event, e);
        }
      });
      if (toggleTask) {
        if (event.extendedProps.isTask) {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = !!event.extendedProps.taskCompleted;
          checkbox.onclick = async e => {
            e.stopPropagation();
            if (e.target) {
              const ret = await toggleTask(event, (e.target as HTMLInputElement).checked);
              if (!ret) {
                (e.target as HTMLInputElement).checked = !(e.target as HTMLInputElement).checked;
              }
            }
          };
          // Make the checkbox more visible against different color events.
          if (textColor == 'black') {
            checkbox.addClass('ofc-checkbox-black');
          } else {
            checkbox.addClass('ofc-checkbox-white');
          }

          if (checkbox.checked) {
            el.addClass('ofc-task-completed');
          }

          // Depending on the view, we should put the checkbox in a different spot.
          const container =
            el.querySelector('.fc-event-time') ||
            el.querySelector('.fc-event-title') ||
            el.querySelector('.fc-list-event-title');

          container?.addClass('ofc-has-checkbox');
          container?.prepend(checkbox);
        }
      }
    },

    viewDidMount: onViewChange,

    // Enable drag-and-drop from external sources (e.g., Tasks Backlog)
    droppable: drop && true,
    drop:
      drop &&
      (info => {
        // Get the task ID from the dragged element's data transfer
        const taskId = info.draggedEl.getAttribute('data-task-id');
        if (taskId) {
          void drop(taskId, info.date);
        }
      }),

    longPressDelay: 250
  });

  cal.render();

  // --- Month / Year navigation ---
  const czMonths = Array.from({ length: 12 }, (_, i) => {
    const n = new Date(2026, i, 1).toLocaleDateString('cs', { month: 'long' });
    return n.charAt(0).toUpperCase() + n.slice(1);
  });

  const btnCls = 'fc-button fc-button-primary';

  // Shared logic: build month and year widgets, wire handlers, return updater
  const wireNavWidget = (
    prevMonthEl: HTMLElement,
    monthNavEl: HTMLElement,
    nextMonthEl: HTMLElement,
    prevYearEl: HTMLElement,
    yearNavEl: HTMLElement,
    nextYearEl: HTMLElement
  ) => {
    // -- Month arrows --
    prevMonthEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = cal.getDate();
      cal.gotoDate(new Date(d.getFullYear(), d.getMonth() - 1, 1));
    });
    nextMonthEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = cal.getDate();
      cal.gotoDate(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    });

    // -- Month dropdown --
    monthNavEl.addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      const currentDate = cal.getDate();
      const menu = new Menu();
      czMonths.forEach((name, i) => {
        menu.addItem(item => {
          item
            .setTitle(name)
            .setIcon(i === currentDate.getMonth() ? 'check' : '')
            .onClick(() => {
              cal.gotoDate(new Date(currentDate.getFullYear(), i, 1));
              if (!cal.view.type.includes('dayGrid')) {
                cal.changeView('dayGridMonth');
              }
            });
        });
      });
      menu.showAtMouseEvent(ev);
    });

    // -- Year click --
    let yearEditing = false;
    let activeYearInput: HTMLInputElement | null = null;

    yearNavEl.addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      if (yearEditing) return;

      const currentDate = cal.getDate();
      const currentYear = currentDate.getFullYear();

      if (isNarrow) {
        // Mobile: year menu (no keyboard, no squashing)
        const menu = new Menu();
        for (let y = currentYear - 4; y <= currentYear + 6; y++) {
          menu.addItem(item => {
            item
              .setTitle(String(y))
              .setIcon(y === currentYear ? 'check' : '')
              .onClick(() => {
                cal.gotoDate(new Date(y, currentDate.getMonth(), 1));
              });
          });
        }
        menu.showAtMouseEvent(ev);
        return;
      }

      // Desktop: floating popup with editable input
      yearEditing = true;

      const popup = document.createElement('div');
      popup.style.cssText =
        'position:fixed;z-index:1000;display:flex;align-items:center;' +
        'padding:8px 12px;background:var(--background-primary);' +
        'border:1px solid var(--background-modifier-border);border-radius:8px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.15);';

      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.value = String(currentYear);
      input.min = '1900';
      input.max = '2100';
      input.style.cssText =
        'width:64px;padding:4px 6px;border:1px solid var(--background-modifier-border);' +
        'border-radius:4px;background:var(--background-secondary);color:var(--text-normal);' +
        'font-size:16px;text-align:center;outline:none;-moz-appearance:textfield;';

      popup.appendChild(input);
      document.body.appendChild(popup);
      activeYearInput = input;

      const rect = yearNavEl.getBoundingClientRect();
      popup.style.left = `${rect.left}px`;
      popup.style.bottom = `${window.innerHeight - rect.top + 6}px`;

      input.focus();
      input.select();

      const close = (commit: boolean) => {
        if (!yearEditing) return;
        yearEditing = false;
        activeYearInput = null;
        popup.remove();
        document.removeEventListener('pointerdown', onOutside);
        if (commit) {
          const y = parseInt(input.value, 10);
          if (!isNaN(y) && y >= 1900 && y <= 2100) {
            cal.gotoDate(new Date(y, cal.getDate().getMonth(), 1));
          }
        }
        yearNavEl.textContent = String(cal.getDate().getFullYear());
      };

      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); close(true); }
        else if (e.key === 'Escape') { e.preventDefault(); close(false); }
      });

      const onOutside = (e: Event) => {
        if (!popup.contains(e.target as Node) && e.target !== yearNavEl) {
          close(true);
        }
      };
      setTimeout(() => document.addEventListener('pointerdown', onOutside), 10);
    });

    // -- Year arrows --
    prevYearEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = cal.getDate();
      cal.gotoDate(new Date(d.getFullYear() - 1, d.getMonth(), 1));
    });
    nextYearEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = cal.getDate();
      cal.gotoDate(new Date(d.getFullYear() + 1, d.getMonth(), 1));
    });

    return () => {
      const d = cal.getDate();
      monthNavEl.textContent = czMonths[d.getMonth()] + ' ▾';
      if (yearEditing && activeYearInput) {
        activeYearInput.value = String(d.getFullYear());
      } else if (!yearEditing) {
        yearNavEl.textContent = String(d.getFullYear());
      }
    };
  };

  if (isNarrow) {
    // --- Mobile: custom two-row toolbar prepended before the calendar ---
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:6px;';

    const row = (leftEl: HTMLElement, rightEls: HTMLElement[]) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
      r.appendChild(leftEl);
      const g = document.createElement('div');
      g.className = 'fc-button-group';
      g.style.cssText = 'display:inline-flex;';
      rightEls.forEach(el => g.appendChild(el));
      r.appendChild(g);
      return r;
    };

    const mkBtn = (text: string, cls?: string) => {
      const b = document.createElement('button');
      b.className = cls || btnCls;
      b.textContent = text;
      b.type = 'button';
      return b;
    };

    const todayBtn = mkBtn('Nyní');
    todayBtn.addEventListener('click', () => cal.today());

    const mPrev = mkBtn('◀');  mPrev.style.setProperty('font-size', '1.3em', 'important');
    const mNav = mkBtn('···');
    const mNext = mkBtn('▶');  mNext.style.setProperty('font-size', '1.3em', 'important');

    const viewBtn = mkBtn('View ▾');
    viewBtn.addEventListener('click', (ev: MouseEvent) => {
      const menu = new Menu();
      const viewOptions: Record<string, string> = {
        dayGridMonth: 'Month', timeGrid3Days: '3 Days',
        timeGridDay: 'Day', listWeek: 'List'
      };
      for (const [vn, vl] of Object.entries(viewOptions)) {
        menu.addItem(item => item.setTitle(vl).onClick(() => cal.changeView(vn)));
      }
      menu.showAtMouseEvent(ev);
    });

    const yPrev = mkBtn('');
    const yNext = mkBtn('');
    const yNav = mkBtn('····');
    for (const [yArrow, glyph] of [[yPrev, '«'], [yNext, '»']] as [HTMLButtonElement, string][]) {
      const span = document.createElement('span');
      span.textContent = glyph;
      span.style.cssText = 'display:block;font-size:2.4em;line-height:1;transform:translateY(-10%);';
      yArrow.appendChild(span);
      yArrow.style.setProperty('display', 'inline-flex', 'important');
      yArrow.style.setProperty('align-items', 'center', 'important');
      yArrow.style.setProperty('justify-content', 'center', 'important');
      yArrow.style.setProperty('padding-top', '0', 'important');
      yArrow.style.setProperty('padding-bottom', '0', 'important');
    }

    toolbar.appendChild(row(todayBtn, [mPrev, mNav, mNext]));
    toolbar.appendChild(row(viewBtn, [yPrev, yNav, yNext]));

    containerEl.appendChild(toolbar);

    const updateMobile = wireNavWidget(mPrev, mNav, mNext, yPrev, yNav, yNext);
    updateMobile();
    cal.on('datesSet', updateMobile);
  } else {
    // --- Desktop: FullCalendar custom buttons, wire after render ---
    const pm = containerEl.querySelector('.fc-prevMonth-button') as HTMLElement;
    const mn = containerEl.querySelector('.fc-monthNav-button') as HTMLElement;
    const nm = containerEl.querySelector('.fc-nextMonth-button') as HTMLElement;
    const py = containerEl.querySelector('.fc-prevYear-button') as HTMLElement;
    const yn = containerEl.querySelector('.fc-yearNav-button') as HTMLElement;
    const ny = containerEl.querySelector('.fc-nextYear-button') as HTMLElement;

    if (pm && mn && nm && py && yn && ny) {
      const updateDesktop = wireNavWidget(pm, mn, nm, py, yn, ny);
      updateDesktop();
      cal.on('datesSet', updateDesktop);
    }
  }

  // Keep DateNavigation for right-click context menus (desktop)
  const dateNavigation = createDateNavigation(cal, containerEl);

  // Add general right-click handler to calendar container for view-level navigation
  if (viewRightClick) {
    containerEl.addEventListener('contextmenu', (event: MouseEvent) => {
      // Only handle if not handled by specific date or event right-clicks
      if (!event.defaultPrevented) {
        event.preventDefault();
        viewRightClick(event, cal);
      }
    });
  }

  return cal;
}
