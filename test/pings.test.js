/**
 * Reminder anti-spam tests. Run with:  npm test
 *
 * The scheduler is exercised against an in-memory event store injected into
 * the require cache, so no database and no Discord connection is needed and
 * nothing real can be pinged. What is proven here is the behaviour the fix
 * checklist demands after the reminder-spam incident:
 *
 *   - a window fires at most once, even across concurrent schedulers
 *   - failed sends retry a bounded number of times and then stop for good
 *   - an event that has ended never gets a ping
 *   - an event that already started closes its expired windows silently
 *     instead of firing all remaining ones in a single tick
 *   - the real sendPing throws when no channel is available (it used to
 *     return null, which logged "Sent ..." without delivering anything)
 */
const assert = require('assert');

const dbPath = require.resolve('../src/db');
const postingPath = require.resolve('../src/bot/events/posting');

/* ------------------------------------------------------------------ fakes */

let store = [];
let sendMode = 'ok'; // 'ok' | 'fail' | 'nochannel'
const sendLog = []; // successful sends: { id, label }
const attemptLog = []; // every attempt, successful or not: { id, label, mode }

const fakePrisma = {
  event: {
    async findMany({ where }) {
      if (where.endTime) {
        // completion query: status in [...] and endTime < lt
        return store.filter(
          (row) => where.status.in.includes(row.status) && row.endTime < where.endTime.lt,
        );
      }
      return store.filter(
        (row) => where.status.in.includes(row.status) && row.startTime >= where.startTime.gte,
      );
    },
    // Atomic claim: the row only updates when every condition matches the
    // current values, exactly like `UPDATE ... WHERE flag = false`.
    async updateMany({ where, data }) {
      const row = store.find((item) => item.id === where.id);
      if (!row) return { count: 0 };
      for (const [key, value] of Object.entries(where)) {
        if (key === 'id') continue;
        if (row[key] !== value) return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    },
    async update({ where, data }) {
      const row = store.find((item) => item.id === where.id);
      if (!row) throw new Error('Record to update not found.');
      Object.assign(row, data);
      return { ...row };
    },
  },
};

const fakePosting = {
  async sendPing(client, event, label) {
    attemptLog.push({ id: event.id, label, mode: sendMode });
    if (sendMode === 'nochannel') {
      throw new Error('no reminders or events channel available (missing channel or access)');
    }
    if (sendMode === 'fail') throw new Error('Missing Access');
    sendLog.push({ id: event.id, label });
    return { id: `msg-${sendLog.length}` };
  },
  async deleteReminderMessage() {
    return null;
  },
  async updateEventMessage() {
    return null;
  },
  async markReminderEnded() {
    return null;
  },
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePrisma };
require.cache[postingPath] = { id: postingPath, filename: postingPath, loaded: true, exports: fakePosting };

const { checkEventPings, completeEndedEvents, __resetForTests } = require('../src/bot/events/pings');

/* ------------------------------------------------------------- utilities */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow.call(Date) + clockOffset;

function resetClock() {
  clockOffset = 0;
}

function makeEvent(overrides = {}) {
  const base = Date.now();
  return {
    id: `evt-${store.length + 1}`,
    title: 'TEST EVENT',
    status: 'SCHEDULED',
    startTime: new Date(base + 6 * HOUR + 55 * MINUTE), // inside the 7h window
    endTime: new Date(base + 7 * HOUR + 55 * MINUTE),
    reminderMessageId: null,
    discordMessageId: null,
    pingOneHour: false,
    pingThirtyMin: false,
    pingTenMin: false,
    pingSevenHours: false,
    pingStarted: false,
    ...overrides,
  };
}

function resetWorld() {
  store = [];
  sendLog.length = 0;
  attemptLog.length = 0;
  sendMode = 'ok';
  resetClock();
  __resetForTests();
}

let passed = 0;
let failed = 0;

async function test(label, fn) {
  resetWorld();
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err.message}`);
  }
}

/* ------------------------------------------------------------------ tests */

async function main() {
  await test('a due window fires exactly once, then stays quiet', async () => {
    store.push(makeEvent());
    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 1, 'first tick sends');
    assert.strictEqual(sendLog[0].label, '7 hours');
    assert.strictEqual(store[0].pingSevenHours, true, 'flag claimed');

    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 1, 'second tick sends nothing');
  });

  await test('two schedulers racing the same window produce one send', async () => {
    store.push(makeEvent());
    // Two instances in the same minute (concurrent ticks).
    await Promise.all([checkEventPings(null), checkEventPings(null)]);
    assert.strictEqual(sendLog.length, 1, `expected 1 send, got ${sendLog.length}`);
    assert.strictEqual(store[0].pingSevenHours, true);

    // A third instance arrives with empty in-memory state (a separate
    // process): only the shared database flag can stop it, and it does.
    __resetForTests();
    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 1, 'the shared flag stops a fresh instance');
    assert.strictEqual(store[0].pingSevenHours, true);
  });

  await test('failed sends give up after 3 attempts instead of retrying forever', async () => {
    const base = Date.now();
    // An event 30 minutes out: the "30 minutes" window is due now; as the
    // clock advances through the loop the later windows open too, so each
    // one gets its own bounded retry cycle.
    store.push(
      makeEvent({
        startTime: new Date(base + 30 * MINUTE),
        endTime: new Date(base + 90 * MINUTE),
      }),
    );
    sendMode = 'fail';

    for (let i = 0; i < 20; i += 1) {
      if (i > 0) clockOffset += 5 * MINUTE + 1000; // step past the per-process cooldown
      await checkEventPings(null);
    }

    // Every window is capped at MAX_ATTEMPTS - the storm stops per window.
    const attemptsByWindow = {};
    for (const attempt of attemptLog) {
      attemptsByWindow[attempt.label] = (attemptsByWindow[attempt.label] || 0) + 1;
    }
    assert.ok(Object.keys(attemptsByWindow).length >= 1, 'at least one window attempted');
    for (const [label, count] of Object.entries(attemptsByWindow)) {
      assert.ok(count <= 3, `"${label}" attempted ${count} times, expected <= 3`);
    }
    // And after everything gave up, later rounds are completely quiet.
    const lateAttempts = attemptLog.filter(
      (attempt) => attempt.label === 'starting' && attempt.mode === 'fail',
    ).length;
    assert.strictEqual(sendLog.length, 0, 'nothing delivered');
    assert.strictEqual(store[0].pingThirtyMin, true, 'window left claimed so everyone stops');
    assert.ok(lateAttempts <= 3, `starting window attempts: ${lateAttempts}`);
  });

  await test('a send with no channel throws instead of logging a false success', async () => {
    store.push(makeEvent());
    sendMode = 'nochannel';

    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 0, 'no false "Sent"');
    assert.strictEqual(attemptLog.length, 1, 'attempt recorded as a failure');
    assert.strictEqual(store[0].pingSevenHours, false, 'claim released for a retry');

    // and the bounded-retry rule still applies
    sendMode = 'fail';
    for (let i = 0; i < 5; i += 1) {
      clockOffset += 6 * MINUTE;
      await checkEventPings(null);
    }
    assert.ok(attemptLog.length <= 3, `attempts capped, got ${attemptLog.length}`);
  });

  await test('an event that already ended never gets pinged', async () => {
    const base = Date.now();
    store.push(
      makeEvent({
        status: 'ACTIVE',
        startTime: new Date(base - 2 * HOUR),
        endTime: new Date(base - 10 * MINUTE),
      }),
    );
    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 0, 'no pings for an ended event');
    // every window closed without posting
    const row = store[0];
    assert.strictEqual(row.pingSevenHours, true);
    assert.strictEqual(row.pingOneHour, true);
    assert.strictEqual(row.pingThirtyMin, true);
    assert.strictEqual(row.pingTenMin, true);
    assert.strictEqual(row.pingStarted, true);

    await completeEndedEvents(null);
    assert.strictEqual(row.status, 'COMPLETED', 'completion marks it done');
  });

  await test('an event that already started closes expired windows without a burst', async () => {
    const base = Date.now();
    store.push(
      makeEvent({
        status: 'ACTIVE',
        startTime: new Date(base - 20 * MINUTE),
        endTime: new Date(base + 40 * MINUTE),
      }),
    );
    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 0, 'no burst of already-expired windows');
    assert.strictEqual(attemptLog.length, 0, 'not even an attempt');
    assert.strictEqual(store[0].pingSevenHours, true, 'closed quietly');
    assert.strictEqual(store[0].pingStarted, true);
  });

  await test('a 2-minute-lead event skips the early windows and pings starting at start', async () => {
    const base = Date.now();
    store.push(
      makeEvent({
        startTime: new Date(base + 2 * MINUTE),
        endTime: new Date(base + 62 * MINUTE),
      }),
    );

    // Created 2 minutes before the start: 7h/1h/30m/10m are all past their
    // moment (a "10 minutes" ping with 2 minutes left is wrong), so they are
    // closed without posting; only `starting` is still ahead.
    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 0, 'no mislabeled early pings');
    assert.strictEqual(store[0].pingSevenHours, true, '7h closed');
    assert.strictEqual(store[0].pingOneHour, true, '1h closed');
    assert.strictEqual(store[0].pingThirtyMin, true, '30m closed');
    assert.strictEqual(store[0].pingTenMin, true, '10m closed');
    assert.strictEqual(store[0].pingStarted, false, 'starting waits for the start');

    // First tick at/after the start: the "starting now" ping fires.
    clockOffset += 3 * MINUTE;
    await checkEventPings(null);
    assert.strictEqual(sendLog.length, 1, 'exactly one ping after start');
    assert.strictEqual(sendLog[0].label, 'starting');
    assert.strictEqual(store[0].pingStarted, true);
    assert.strictEqual(store[0].status, 'ACTIVE', 'status flipped with the ping');
  });

  await test('a started event flips to ACTIVE even when every window is stale', async () => {
    const base = Date.now();
    store.push(
      makeEvent({
        status: 'SCHEDULED',
        startTime: new Date(base - 20 * MINUTE),
        endTime: new Date(base + 40 * MINUTE),
      }),
    );
    await checkEventPings(null);
    assert.strictEqual(store[0].status, 'ACTIVE', 'set by the clock, not by ping delivery');
    assert.strictEqual(sendLog.length, 0, 'nothing left to ping');
    assert.strictEqual(store[0].pingStarted, true, 'starting window closed as stale');
  });

  await test('the completion pass runs before pings would see the event', async () => {
    const base = Date.now();
    const event = makeEvent({
      status: 'ACTIVE',
      startTime: new Date(base - 2 * HOUR),
      endTime: new Date(base - 1 * MINUTE),
    });
    store.push(event);
    await completeEndedEvents(null);
    await checkEventPings(null);
    assert.strictEqual(event.status, 'COMPLETED');
    assert.strictEqual(sendLog.length, 0);
  });

  // The real posting module: no channel must be an error, not a silent null.
  delete require.cache[postingPath];
  const realPosting = require('../src/bot/events/posting');
  await test('real sendPing rejects when no channel can be found', async () => {
    const client = {
      channels: { fetch: async () => null },
      guilds: { fetch: async () => { throw new Error('Unknown Guild'); } },
    };
    await assert.rejects(
      () => realPosting.sendPing(client, makeEvent(), '7 hours'),
      /no reminders or events channel/,
    );
  });

  /* ------------------------------------------- finished-card presentation */

  const { buildEventEmbed } = require('../src/bot/events/embeds');
  const GREEN = 0x10b981;
  const RED = 0xed4245;
  const finished = () =>
    makeEvent({
      status: 'COMPLETED',
      startTime: new Date(Date.now() - 2 * HOUR),
      endTime: new Date(Date.now() - HOUR),
    });

  await test('completed embed is emerald green with a check and a status line', async () => {
    const data = buildEventEmbed(finished()).toJSON();
    assert.strictEqual(data.color, GREEN, `expected emerald green, got 0x${data.color?.toString(16)}`);
    assert.ok(data.title.startsWith('✅'), `title: ${data.title}`);
    assert.ok(data.footer.text.includes('Event Completed'), `footer: ${data.footer.text}`);
    const status = data.fields.find((field) => field.name === 'Status');
    assert.ok(status, 'Status field present');
    assert.ok(status.value.includes('✅ **Completed**'), `status: ${status.value}`);
    assert.ok(status.value.includes('ended'), `status should say when it ended: ${status.value}`);
  });

  await test('cancelled embed is red with a cross and a status line', async () => {
    const data = buildEventEmbed(makeEvent({ status: 'CANCELLED' }), { cancelled: true }).toJSON();
    assert.strictEqual(data.color, RED, `expected red, got 0x${data.color?.toString(16)}`);
    assert.ok(data.title.startsWith('❌'), `title: ${data.title}`);
    assert.ok(data.footer.text.includes('Event Cancelled'), `footer: ${data.footer.text}`);
    const status = data.fields.find((field) => field.name === 'Status');
    assert.ok(status && status.value.includes('❌ **Cancelled**'), `status: ${status?.value}`);
  });

  async function reminderClient(edits) {
    const message = {
      content: '@everyone 🔔 Don\'t forget we have **TEST EVENT** later!',
      edit: async (payload) => {
        edits.push(payload);
        return message;
      },
    };
    const channel = { messages: { fetch: async () => message } };
    return {
      // Works whether REMINDERS_CHANNEL_ID is configured (fetch by id) or
      // not (fall back to locating the channel by name in the guild).
      channels: { fetch: async () => channel },
      guilds: {
        fetch: async () => ({
          channels: {
            fetch: async () => [
              { isTextBased: () => true, name: 'reminders', id: 'r1', messages: channel.messages },
            ],
          },
        }),
      },
    };
  }

  await test('ending an event rebuilds the reminder into a green ✅ card', async () => {
    const edits = [];
    const client = await reminderClient(edits);
    const event = { ...finished(), reminderMessageId: 'msg-1' };

    await realPosting.markReminderEnded(client, event);

    assert.strictEqual(edits.length, 1, 'reminder edited once');
    const { content, embeds } = edits[0];
    assert.strictEqual(content, '✅ **EVENT ENDED**', 'stale @everyone text replaced');
    assert.ok(!content.includes('@everyone'), 'the edit must not re-notify the channel');
    const data = embeds[0].toJSON();
    assert.strictEqual(data.color, GREEN, 'card is emerald green');
    assert.ok(data.title.startsWith('✅'), `title: ${data.title}`);
    assert.ok(data.fields.some((field) => field.name === 'Status'), 'status line present');
  });

  await test('cancelling an event restyles the reminder into a red ❌ card', async () => {
    const edits = [];
    const client = await reminderClient(edits);
    const event = { ...makeEvent({ status: 'CANCELLED' }), reminderMessageId: 'msg-1' };

    await realPosting.markReminderCancelled(client, event);

    assert.strictEqual(edits.length, 1, 'reminder edited once');
    const { content, embeds } = edits[0];
    assert.strictEqual(content, '❌ **EVENT CANCELLED**');
    const data = embeds[0].toJSON();
    assert.strictEqual(data.color, RED, 'card is red');
    assert.ok(data.title.startsWith('❌'), `title: ${data.title}`);
  });

  Date.now = realNow;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  Date.now = realNow;
  console.error(err);
  process.exit(1);
});
