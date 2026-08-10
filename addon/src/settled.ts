import {
  macroCondition,
  dependencySatisfies,
  importSync,
} from '@embroider/macros';
import { Test } from 'ember-testing';

import { nextTick } from './-utils.ts';
import { hasPendingTransitions } from './setup-application-context.ts';
import { buildWaiter, hasPendingWaiters } from '@ember/test-waiters';
import * as testWaiters from '@ember/test-waiters';
import type DebugInfo from './-internal/debug-info.ts';
import { TestDebugInfo } from './-internal/debug-info.ts';
import renderSettled from './-internal/render-settled.ts';

// This is private API. Runloop-less builds of ember-source (the RFC 957
// spikes) do not export `_backburner` at all, so it is read off the module
// namespace -- a missing export degrades to `undefined` here instead of a
// build-time missing-export error in consuming apps.
const _backburner: any = (importSync('@ember/runloop') as any)._backburner;

// Ember builds that schedule rendering without the runloop report the
// EDGES of rendering work (pending / complete) rather than exposing a
// pollable flag. Bridging those edges into a test waiter folds rendering
// into the same settledness protocol as every other async source: it
// needs no clause of its own in `isSettled` below, and a render that
// never completes is reported by name in test-waiter debug output.
const renderWaiter = buildWaiter('@ember/test-helpers:render');
let renderWaiterToken: unknown = null;

const usesRenderWaiter = (() => {
  if (macroCondition(dependencySatisfies('ember-source', '>=4.5.0-beta.1'))) {
    const renderer = importSync('@ember/renderer') as any;

    if (typeof renderer._onRenderSettledChange === 'function') {
      renderer._onRenderSettledChange((pending: boolean) => {
        if (pending) {
          renderWaiterToken ??= renderWaiter.beginAsync();
        } else if (renderWaiterToken !== null) {
          const token = renderWaiterToken;

          renderWaiterToken = null;
          renderWaiter.endAsync(token);
        }
      });

      return true;
    }
  }

  return false;
})();

let requests: XMLHttpRequest[];
const checkWaiters = Test.checkWaiters;

/**
  @private
  @returns {number} the count of pending requests
*/
function pendingRequests() {
  return requests !== undefined ? requests.length : 0;
}

/**
  @private
  @param {Event} event (unused)
  @param {XMLHTTPRequest} xhr the XHR that has initiated a request
*/
function incrementAjaxPendingRequests(event: any, xhr: XMLHttpRequest): void {
  requests.push(xhr);
}

/**
  @private
  @param {Event} event (unused)
  @param {XMLHTTPRequest} xhr the XHR that has initiated a request
*/
function decrementAjaxPendingRequests(event: any, xhr: XMLHttpRequest): void {
  // In most Ember versions to date (current version is 2.16) RSVP promises are
  // configured to flush in the actions queue of the Ember run loop, however it
  // is possible that in the future this changes to use "true" micro-task
  // queues.
  //
  // The entire point here, is that _whenever_ promises are resolved will be
  // before the next run of the JS event loop. Then in the next event loop this
  // counter will decrement. In the specific case of AJAX, this means that any
  // promises chained off of `$.ajax` will properly have their `.then` called
  // _before_ this is decremented (and testing continues)
  nextTick(() => {
    for (let i = 0; i < requests.length; i++) {
      if (xhr === requests[i]) {
        requests.splice(i, 1);
      }
    }
  });
}

/**
  Clears listeners that were previously setup for `ajaxSend` and `ajaxComplete`.

  @private
*/
export function _teardownAJAXHooks() {
  // jQuery will not invoke `ajaxComplete` if
  //    1. `transport.send` throws synchronously and
  //    2. it has an `error` option which also throws synchronously

  // We can no longer handle any remaining requests
  requests = [];

  if (typeof (globalThis as any).jQuery === 'undefined') {
    return;
  }

  (globalThis as any)
    .jQuery(document)
    .off('ajaxSend', incrementAjaxPendingRequests);
  (globalThis as any)
    .jQuery(document)
    .off('ajaxComplete', decrementAjaxPendingRequests);
}

/**
  Sets up listeners for `ajaxSend` and `ajaxComplete`.

  @private
*/
export function _setupAJAXHooks() {
  requests = [];

  if (typeof (globalThis as any).jQuery === 'undefined') {
    return;
  }

  (globalThis as any)
    .jQuery(document)
    .on('ajaxSend', incrementAjaxPendingRequests);
  (globalThis as any)
    .jQuery(document)
    .on('ajaxComplete', decrementAjaxPendingRequests);
}

export interface SettledState {
  hasRunLoop: boolean;
  hasPendingTimers: boolean;
  hasPendingWaiters: boolean;
  hasPendingRequests: boolean;
  hasPendingTransitions: boolean | null;
  isRenderPending: boolean;
  pendingRequestCount: number;
  debugInfo: DebugInfo;
}

/**
  Check various settledness metrics, and return an object with the following properties:

  - `hasRunLoop` - Checks if a run-loop has been started. If it has, this will
    be `true` otherwise it will be `false`.
  - `hasPendingTimers` - Checks if there are scheduled timers in the run-loop.
    These pending timers are primarily registered by `Ember.run.schedule`. If
    there are pending timers, this will be `true`, otherwise `false`.
  - `hasPendingWaiters` - Checks if any registered test waiters are still
    pending (e.g. the waiter returns `true`). If there are pending waiters,
    this will be `true`, otherwise `false`.
  - `hasPendingRequests` - Checks if there are pending AJAX requests (based on
    `ajaxSend` / `ajaxComplete` events triggered by `jQuery.ajax`). If there
    are pending requests, this will be `true`, otherwise `false`.
  - `hasPendingTransitions` - Checks if there are pending route transitions. If the
    router has not been instantiated / setup for the test yet this will return `null`,
    if there are pending transitions, this will be `true`, otherwise `false`.
  - `pendingRequestCount` - The count of pending AJAX requests.
  - `debugInfo` - Debug information that's combined with info return from backburner's
    getDebugInfo method.
  - `isRenderPending` - Checks if there are any pending render operations. This will be true as long
    as there are tracked values in the template that have not been rerendered yet.

  @public
  @returns {Object} object with properties for each of the metrics used to determine settledness
*/
export function getSettledState(): SettledState {
  const hasPendingTimers = _backburner ? _backburner.hasTimers() : false;
  const hasRunLoop = _backburner ? Boolean(_backburner.currentInstance) : false;
  const hasPendingLegacyWaiters = checkWaiters();
  const hasPendingTestWaiters = hasPendingWaiters();
  const pendingRequestCount = pendingRequests();
  const hasPendingRequests = pendingRequestCount > 0;
  // On runloop-driven builds, a pending render is observable as backburner's
  // autorun instance. Scheduler-driven builds report render edges into the
  // render waiter above, so a pending render is already counted in
  // `hasPendingTestWaiters` -- reporting it here too would double-count it.
  const isRenderPending = usesRenderWaiter ? false : !!hasRunLoop;

  return {
    hasPendingTimers,
    hasRunLoop,
    hasPendingWaiters: hasPendingLegacyWaiters || hasPendingTestWaiters,
    hasPendingRequests,
    hasPendingTransitions: hasPendingTransitions(),
    isRenderPending,
    pendingRequestCount,
    debugInfo: new TestDebugInfo({
      hasPendingTimers,
      hasRunLoop,
      hasPendingLegacyWaiters,
      hasPendingTestWaiters,
      hasPendingRequests,
      isRenderPending,
    }),
  };
}

/**
  Checks various settledness metrics (via `getSettledState()`) to determine if things are settled or not.

  Settled generally means that there are no pending timers, no pending waiters,
  no pending AJAX requests, and no current run loop. However, new settledness
  metrics may be added and used as they become available.

  @public
  @returns {boolean} `true` if settled, `false` otherwise
*/
export function isSettled(): boolean {
  const {
    hasPendingTimers,
    hasRunLoop,
    hasPendingRequests,
    hasPendingWaiters,
    hasPendingTransitions,
    isRenderPending,
  } = getSettledState();

  if (
    hasPendingTimers ||
    hasRunLoop ||
    hasPendingRequests ||
    hasPendingWaiters ||
    hasPendingTransitions ||
    isRenderPending
  ) {
    return false;
  }

  return true;
}

/**
  Returns a promise that resolves when in a settled state (see `isSettled` for
  a definition of "settled state").

  @public
  @returns {Promise<void>} resolves when settled
*/
/**
 * Waiter completion is announced by `@ember/test-waiters` versions that
 * export `waitersSettled`; older ones are pull-only, and the fallback
 * tick below drives the loop instead.
 *
 * @private
 */
const maybeWaitersSettled = (
  testWaiters as unknown as { waitersSettled?: () => Promise<unknown> }
).waitersSettled;

const waitersSettled: (() => Promise<unknown>) | null =
  typeof maybeWaitersSettled === 'function' ? maybeWaitersSettled : null;

/**
 * How long the fallback tick waits.
 *
 * When waiters announce completion, this tick is a safety net for the
 * sources that cannot: `Waiter` implementations written against the
 * interface directly, legacy `Ember.Test.registerWaiter` callbacks, and
 * request counters. It must then comfortably exceed a frame, because a
 * render tick can be frame-paced -- at 10ms it beat rendering to the
 * race often enough to decide a quarter of all iterations (measured 30
 * of 117), costing an extra pass each time; at 50ms it decided 1 of 92.
 *
 * Without waiter notification it is the loop's only clock, so it stays
 * at the cadence the previous `waitUntil`-based implementation used.
 *
 * @private
 */
const FALLBACK_MS = waitersSettled === null ? 10 : 50;

function fallbackTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FALLBACK_MS));
}

/**
 * Resolves when no waiter is pending, on versions that can tell us.
 * Otherwise never resolves, leaving the fallback tick to drive.
 *
 * @private
 */
function waitersQuiet(): Promise<unknown> {
  return waitersSettled === null ? new Promise(() => {}) : waitersSettled();
}

/**
 * Yields to the task queue, so quiet is observed from a macrotask.
 *
 * @private
 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export default async function settled(): Promise<void> {
  // Settledness is awaited rather than polled: rendering resolves
  // `renderSettled()` when it completes, and waiters resolve
  // `waitersSettled()` from the operations' own completion promises. The
  // fallback tick is raced alongside them only to cover sources that
  // cannot announce completion -- when everything announces, it never
  // decides anything.
  //
  // Two properties this loop must preserve:
  //
  // 1. Quiet is confirmed FROM A MACROTASK. Task sources that are
  //    already queued (worker messages, zero-delay timers) may register
  //    waiters or dirty tracked state, and an observation made in
  //    microtask context would win the race against them and settle
  //    early. The previous waitUntil-based implementation imposed this
  //    boundary implicitly by scheduling every check via setTimeout.
  //
  // 2. It re-checks. Completing the work that was pending can start
  //    more of it, so one pass proves nothing; the loop runs until a
  //    pass observes everything quiet.
  for (;;) {
    await Promise.race([
      Promise.all([renderSettled(), waitersQuiet()]),
      fallbackTick(),
    ]);

    await macrotask();

    if (isSettled()) {
      return;
    }
  }
}
