import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bestie_state', Path(__file__).with_name('state.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
OWNER, OTHER, EVENT = 'a' * 64, 'b' * 64, 'c' * 64
CHANNEL = '11111111-1111-4111-8111-111111111111'
TEXT = 'Alex is my brother. Jo is my friend. We are the Thursday group. Remind me tomorrow.'


class StateTests(unittest.TestCase):
    def setUp(self):
        self.state = s.initial(OWNER, CHANNEL, 100)
        self.events = {EVENT: {'id': EVENT, 'pubkey': OWNER, 'kind': 9,
                              'tags': [['h', CHANNEL]], 'created_at': 90, 'content': TEXT}}
        self.source = {'event': EVENT, 'quote': 'Alex is my brother'}

    def apply(self, operations, event=EVENT, now=100):
        return s.transition(self.state, {'event': event, 'quote': TEXT, 'operations': operations}, now,
                            self.events.get, lambda key: {'workflow_id': key})

    def remember(self, kind='people', key='alex', text='Alex is my brother', links=None):
        return {'action': 'remember', 'kind': kind, 'id': key, 'title': key,
                'text': text, 'source': self.source, 'links': links or []}

    def test_world_and_correction_preserve_relationships_and_workflow(self):
        self.state = self.apply([self.remember(), self.remember('people', 'jo'),
            self.remember('groups', 'thursday', links=['people/alex', 'people/jo']),
            self.remember('commitments', 'reminder'),
            {'action': 'workflow', 'id': 'reminder', 'workflow': 'workflow-1'}])
        restored = json.loads(s.encode(self.state))  # fresh process state, no conversation needed
        self.state = restored
        result = self.apply([self.remember('commitments', 'reminder', 'Cancelled by owner')])
        self.assertEqual(result['memory']['groups'], restored['memory']['groups'])
        self.assertEqual(result['memory']['commitments']['reminder']['workflow'], 'workflow-1')
        self.assertEqual(len(result['memory']['commitments']['reminder']['revisions']), 2)
        self.assertEqual(result['notes'][0]['at'], 90)  # source time, not later runtime date

    def test_correction_keeps_links_and_replayed_plan_is_idempotent(self):
        self.state = self.apply([self.remember(), self.remember('groups', 'thursday', links=['people/alex'])])
        correction = self.remember('groups', 'thursday', 'Thursday group changed meeting time')
        del correction['links']
        self.state = self.apply([correction])
        self.assertEqual(self.state['memory']['groups']['thursday']['links'], ['people/alex'])
        replay = self.apply([correction])
        self.assertEqual(replay, self.state)

    def test_untrusted_or_foreign_evidence_rejects_whole_plan(self):
        for mutation in ({'pubkey': OTHER}, {'tags': [['h', 'other']]}, {'content': 'different'}):
            with self.subTest(mutation=mutation):
                saved = copy.deepcopy(self.events[EVENT])
                self.events[EVENT].update(mutation)
                with self.assertRaises(ValueError):
                    self.apply([self.remember()])
                self.events[EVENT] = saved
        with self.assertRaises(ValueError):
            self.apply([self.remember(), self.remember('groups', 'bad', links=['people/missing'])])
        self.assertEqual(self.state['memory']['people'], {})

    def test_recipe_skip_resume_and_completion_evidence(self):
        with self.assertRaises(ValueError):
            self.apply([{'action': 'recipe', 'id': 'remember-world', 'status': 'completed'}])
        self.state = self.apply([{'action': 'recipe', 'id': 'remember-world', 'status': 'skipped'}])
        self.state = self.apply([{'action': 'recipe', 'id': 'remember-world', 'status': 'accepted'}])
        with self.assertRaises(ValueError):
            self.apply([{'action': 'recipe', 'id': 'remember-world', 'status': 'completed', 'evidence': [self.source]}])
        result = self.apply([self.remember(), {'action': 'recipe', 'id': 'remember-world',
                            'status': 'completed', 'evidence': [self.source]}])
        self.assertEqual(result['recipes']['remember-world']['status'], 'completed')

    def test_paused_not_due_and_due_dreams(self):
        dream = {'action': 'dream', 'summary': 'Question: would a group plan help?', 'sources': [self.source]}
        receipt = {'action': 'run', 'id': 'dream', 'summary': 'Saved one reflection'}
        with self.assertRaises(ValueError):
            self.apply([dream, receipt], 'heartbeat')
        self.state = self.apply([{'action': 'cadence', 'id': 'dream', 'enabled': True, 'interval': 3600}])
        with self.assertRaises(ValueError):
            self.apply([dream, receipt], 'heartbeat', 3699)
        self.state = self.apply([dream, receipt], 'heartbeat', 3700)
        self.assertEqual(self.state['cadences']['dream']['nextDue'], 7300)
        self.assertEqual(self.state['dreams'][0]['status'], 'reflection-not-fact')
        self.assertEqual(self.state['memory']['people'], {})
        with self.assertRaises(ValueError):
            self.apply([dream, receipt], 'heartbeat', 3701)
        with self.assertRaises(ValueError):
            self.apply([self.remember()], 'heartbeat', 7300)

    def test_manual_dream_while_paused_and_atomic_receipt(self):
        dream = {'action': 'dream', 'summary': 'A reflection', 'sources': [self.source]}
        with self.assertRaises(ValueError):
            self.apply([dream])
        self.state = self.apply([dream, {'action': 'run', 'id': 'dream', 'summary': 'Reflected'}])
        self.assertFalse(self.state['cadences']['dream']['enabled'])
        self.assertEqual(len(self.state['dreams']), 1)

    def test_capacity_stops_without_eviction(self):
        self.state['notes'] = [{'event': EVENT, 'at': 90, 'changes': ['x' * s.LIMIT]}]
        before = copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError, 'budget'):
            self.apply([self.remember()])
        self.assertEqual(self.state, before)

    def test_cli_rejects_stale_hash_before_writing(self):
        with patch.object(s, 'read', return_value=(s.encode(self.state), self.state)), \
             patch.object(s.sys, 'argv', ['state.py', 'apply']), \
             patch.object(s.sys.stdin, 'read', return_value=json.dumps({'base': 'stale', 'operations': [self.remember()]})), \
             patch.object(s, 'buzz') as buzz:
            with self.assertRaisesRegex(ValueError, 'changed'):
                s.main()
            buzz.assert_not_called()

    def test_relative_reminder_uses_request_time_and_rejects_missed_deadline(self):
        event = {'created_at': 1790372360}
        value = s.reminder_time(event, 300, 1790372400)
        self.assertEqual(value['dueAt'], 1790372660)
        self.assertEqual(value['cron'], '20 44 21 25 9 * 2026')
        with self.assertRaisesRegex(ValueError, 'passed'):
            s.reminder_time(event, 300, 1790372660)

    def test_source_query_normalizes_cli_array(self):
        with patch.object(s, 'buzz', return_value=json.dumps([self.events[EVENT]])):
            self.assertEqual(s.event_reader()(EVENT)['pubkey'], OWNER)
        with patch.object(s, 'buzz', return_value='[]'):
            with self.assertRaises(ValueError):
                s.event_reader()(EVENT)


if __name__ == '__main__':
    unittest.main()
