#!/usr/bin/env python3
"""Bestie v1: bounded, evidence-linked transitions over one owner-private engram.
No scheduler, credentials store, model client, or message sender lives here.
"""
import copy
import difflib
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time

SLUG = 'mem/bestie'
LIMIT = 48 * 1024
HEX = re.compile(r'^[0-9a-f]{64}$')
ID = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
KINDS = ('people', 'groups', 'relationships', 'facts', 'commitments')
RECIPES = ('small-task', 'remember-world', 'check-in')
CADENCES = {'onboarding': 86400, 'commitments': 3600, 'dream': 86400}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def string(value, limit=2000):
    require(isinstance(value, str) and 0 < len(value) <= limit, 'Invalid text')
    return value


def identifier(value):
    require(isinstance(value, str) and ID.fullmatch(value), 'Invalid stable ID')
    return value


def initial(owner, channel, now):
    require(HEX.fullmatch(owner), 'Invalid owner')
    require(re.fullmatch(r'[0-9a-f-]{36}', channel), 'Invalid channel')
    return {'version': 1, 'owner': owner, 'channel': channel, 'revision': 0,
            'recipes': {key: {'status': 'available', 'evidence': []} for key in RECIPES},
            'cadences': {key: {'enabled': False, 'interval': interval, 'nextDue': now + interval}
                         for key, interval in CADENCES.items()},
            'memory': {key: {} for key in KINDS}, 'notes': [], 'dreams': [], 'runs': []}


def evidence(state, item, get_event, owner_only=True):
    require(isinstance(item, dict) and HEX.fullmatch(item.get('event', '')), 'Source event required')
    event = get_event(item['event'])
    require(isinstance(event, dict) and event.get('id') == item['event'], 'Source not found')
    require(event.get('kind') == 9 and ['h', state['channel']] in event.get('tags', []),
            'Source must be a message in the bound channel')
    if owner_only:
        require(event.get('pubkey') == state['owner'], 'Personal facts require owner evidence')
    quote = string(item.get('quote'))
    require(quote in event.get('content', ''), 'Quote is absent from source')
    return {'event': item['event'], 'quote': quote}


def transition(before, plan, now, get_event, get_workflow):
    """Validate everything before returning a new state; callers own persistence."""
    require(before.get('version') == 1, 'Unsupported state version')
    require(isinstance(plan, dict), 'Expected a transition object')
    ops = plan.get('operations')
    require(isinstance(ops, list) and 0 < len(ops) <= 20, 'Use 1–20 operations')
    origin = plan.get('event')
    background = origin == 'heartbeat'
    if not background:
        evidence(before, {'event': origin, 'quote': plan.get('quote')}, get_event)
    plan_key = digest(encode({'event': origin, 'operations': ops}))
    if not background and any(note.get('key') == plan_key for note in before['notes']):
        return before
    state = copy.deepcopy(before)
    changes = []
    for op in ops:
        require(isinstance(op, dict), 'Invalid operation')
        action = op.get('action')
        if action == 'remember':
            require(not background, 'Heartbeat cannot create personal facts')
            kind, key = op.get('kind'), identifier(op.get('id'))
            require(kind in KINDS, 'Unknown memory kind')
            source = evidence(state, op.get('source'), get_event)
            require(source['event'] == origin, 'New facts must cite this owner turn')
            text = string(op.get('text'))
            title = string(op.get('title'), 120)
            previous = state['memory'][kind].get(key)
            links = op.get('links', previous['links'][:] if previous else [])
            require(isinstance(links, list) and len(links) <= 12, 'Invalid links')
            for link in links:
                require(isinstance(link, str) and '/' in link, 'Invalid memory link')
                section, linked_id = link.split('/', 1)
                require(section in KINDS and linked_id in state['memory'][section], 'Link target missing')
            # Corrections append a revision, preserving evidence and unrelated records.
            revisions = previous['revisions'][:] if previous else []
            if not revisions or revisions[-1]['text'] != text:
                revisions.append({'text': text, 'source': source, 'at': now})
            state['memory'][kind][key] = {**(previous or {}), 'title': title, 'links': links, 'revisions': revisions}
            changes.append(kind + '/' + key)
        elif action == 'recipe':
            require(not background, 'Recipe changes require an owner turn')
            key, status = op.get('id'), op.get('status')
            require(key in RECIPES and status in ('offered', 'accepted', 'skipped', 'completed'), 'Invalid recipe')
            prior = state['recipes'][key]['status']
            allowed = {'available': ('offered', 'accepted', 'skipped'), 'offered': ('accepted', 'skipped'),
                       'accepted': ('completed', 'skipped'), 'skipped': ('accepted',), 'completed': ()}
            require(status == prior or status in allowed[prior], 'Invalid recipe transition')
            sources = [evidence(state, item, get_event, False) for item in op.get('evidence', [])]
            require(len(sources) <= 8, 'Too much recipe evidence')
            if status == 'completed':
                require(sources, 'Completion needs message evidence')
                if key == 'remember-world':
                    require(state['memory']['people'] or state['memory']['groups'] or state['memory']['facts'],
                            'Remember recipe needs saved memory')
                if key == 'check-in':
                    require(any('workflow' in row for row in state['memory']['commitments'].values()),
                            'Check-in recipe needs a verified workflow')
            state['recipes'][key] = {'status': status, 'evidence': sources}
            changes.append('recipes/' + key)
        elif action == 'workflow':
            require(not background, 'Workflow changes require an owner turn')
            key = identifier(op.get('id'))
            row = state['memory']['commitments'].get(key)
            require(row is not None, 'Remember the accepted commitment first')
            workflow_id = string(op.get('workflow'), 64)
            workflow = get_workflow(workflow_id)
            require(workflow is not None, 'Workflow readback failed')
            # CLI definitions are YAML; require exact workflow/channel identity in readback.
            require(workflow.get('workflow_id') == workflow_id, 'Workflow identity mismatch')
            row['workflow'] = workflow_id
            changes.append('commitments/' + key)
        elif action == 'cadence':
            require(not background, 'Cadence changes require an owner turn')
            key, enabled = op.get('id'), op.get('enabled')
            interval = op.get('interval', CADENCES.get(key))
            require(key in CADENCES and isinstance(enabled, bool), 'Invalid cadence')
            require(type(interval) is int and 3600 <= interval <= 604800, 'Cadence must be 1 hour–7 days')
            state['cadences'][key] = {'enabled': enabled, 'interval': interval, 'nextDue': now + interval}
            changes.append('cadences/' + key)
        elif action == 'dream':
            if background:
                cadence = state['cadences']['dream']
                require(cadence['enabled'] and cadence['nextDue'] <= now, 'Dream is not due')
            sources = [evidence(state, item, get_event) for item in op.get('sources', [])]
            require(0 < len(sources) <= 12, 'Dream needs 1–12 owner sources')
            state['dreams'].append({'at': now, 'summary': string(op.get('summary'), 4000),
                                    'sources': sources, 'status': 'reflection-not-fact'})
            require(len(state['dreams']) <= 30, 'Dream capacity reached; owner must choose an archive policy')
            changes.append('dreams')
        elif action == 'run':
            key = op.get('id')
            require(key in CADENCES, 'Unknown background purpose')
            cadence = state['cadences'][key]
            if background:
                require(cadence['enabled'] and cadence['nextDue'] <= now, 'Operation is paused or not due')
            require(key != 'dream' or 'dreams' in changes, 'A dream run needs a saved dream')
            cadence['nextDue'] = now + cadence['interval']
            state['runs'].append({'purpose': key, 'at': now, 'summary': string(op.get('summary'), 1000),
                                  'trigger': origin})
            state['runs'] = state['runs'][-40:]
            changes.append('runs/' + key)
        else:
            raise ValueError('Unknown operation')
    if 'dreams' in changes:
        require('runs/dream' in changes, 'Dream and run receipt must be saved together')
    if not background:
        note = {'event': origin, 'at': get_event(origin)['created_at'], 'changes': changes, 'key': plan_key}
        if not state['notes'] or state['notes'][-1] != note:
            state['notes'].append(note)
    state['revision'] += 1
    require(len(encode(state).encode()) <= LIMIT, 'Memory budget reached; no automatic eviction')
    return state


def buzz(*args, content=None):
    result = subprocess.run(['buzz', *args], input=content, text=True, capture_output=True, timeout=45)
    if result.returncode != 0:
        try:
            error = json.loads(result.stderr)
        except ValueError:
            error = {}
        if args == ('mem', 'get', SLUG) and error.get('error') == 'not_found':
            raise ValueError('Baseline state missing or tombstoned. Use init only for first owner contact; init refuses tombstones.')
        raise ValueError('Buzz operation failed; no success recorded. Check access/connection and reread.')
    return result.stdout


def owner():
    tag = json.loads(os.environ.get('BUZZ_AUTH_TAG', 'null'))
    require(isinstance(tag, list) and len(tag) >= 4 and tag[0] == 'auth' and HEX.fullmatch(tag[1]),
            'Owner-attested agent environment required')
    return tag[1]


def read():
    raw = buzz('mem', 'get', SLUG)
    state = json.loads(raw)
    require(state.get('owner') == owner() and state.get('version') == 1, 'State owner/version mismatch')
    return raw, state


def event_reader():
    cache = {}
    def get(event_id):
        if event_id not in cache:
            require(HEX.fullmatch(event_id), 'Invalid event ID')
            value = json.loads(buzz('social', 'event', '--event', event_id))
            require(isinstance(value, list) and len(value) == 1, 'Source event unavailable')
            cache[event_id] = value[0]
        return cache[event_id]
    return get


def reminder_time(event, delay, now):
    require(type(delay) is int and 60 <= delay <= 604800, 'Relative reminder must be 1 minute–7 days')
    due = event['created_at'] + delay
    require(due > now, 'Requested reminder time has passed; ask the owner for a new time')
    date = datetime.datetime.fromtimestamp(due, datetime.timezone.utc)
    return {'dueAt': due, 'utc': date.isoformat(),
            'cron': f'{date.second} {date.minute} {date.hour} {date.day} {date.month} * {date.year}'}


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else 'read'
    now = int(time.time())
    if command == 'due':
        require(len(sys.argv) == 4, 'due OWNER_MESSAGE_EVENT DELAY_SECONDS')
        _, state = read()
        get = event_reader()
        event = get(sys.argv[2])
        evidence(state, {'event': sys.argv[2], 'quote': event.get('content')}, get)
        print(encode(reminder_time(event, int(sys.argv[3]), now)))
        return
    if command == 'init':
        require(len(sys.argv) == 4, 'init CHANNEL OWNER_MESSAGE_EVENT')
        probe = subprocess.run(['buzz', 'mem', 'get', SLUG], text=True, capture_output=True, timeout=45)
        require(probe.returncode != 0, 'Already initialized; use read')
        try:
            error = json.loads(probe.stderr)
        except ValueError:
            error = {}
        require(error.get('error') == 'not_found' and 'tombstoned' not in error.get('message', ''), 'Cannot establish missing state; initialization stopped')
        state = initial(owner(), sys.argv[2], now)
        get = event_reader()
        event = get(sys.argv[3])
        evidence(state, {'event': sys.argv[3], 'quote': event.get('content')}, get)
        buzz('mem', 'set', SLUG, '-', content=encode(state))
    elif command == 'apply':
        plan = json.loads(sys.stdin.read(LIMIT + 1))
        raw, before = read()
        require(plan.get('base') == digest(raw), 'State changed; reread before planning')
        state = transition(before, plan, now, event_reader(),
                           lambda key: next((row for row in json.loads(buzz('workflows', 'list', '--channel', before['channel']))
                                             if row.get('workflow_id') == key), None))
        after = encode(state)
        if after == raw:
            print(encode({'saved': True, 'revision': state['revision'], 'hash': digest(raw), 'alreadyApplied': True}))
            return
        patch = ''.join(difflib.unified_diff(raw.splitlines(True), after.splitlines(True),
                                           fromfile=SLUG, tofile=SLUG))
        buzz('mem', 'patch', SLUG, '--base-hash', digest(raw), content=patch)
        current, saved = read()
        require(current == after, 'Write not confirmed; reread and reconcile before retrying')
        print(encode({'saved': True, 'revision': saved['revision'], 'hash': digest(current)}))
        return
    else:
        require(command == 'read', 'Use init, read, due, or apply (JSON stdin)')
    raw, state = read()
    print(encode({'hash': digest(raw), 'state': state,
                  'due': [key for key, value in state['cadences'].items()
                          if value['enabled'] and value['nextDue'] <= now]}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError, OSError) as error:
        # Never emit subprocess stderr or credential-bearing arguments.
        print('Bestie: ' + str(error) if isinstance(error, ValueError) else 'Bestie: operation failed; reread before retrying', file=sys.stderr)
        sys.exit(1)
