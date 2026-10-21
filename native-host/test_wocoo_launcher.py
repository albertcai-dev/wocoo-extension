"""Tests for the native host's draft-store actions. Run: python3 -m unittest native-host/test_wocoo_launcher.py -v

Each test runs the real host script as a subprocess (stdin/stdout framed with Chrome's
4-byte little-endian length prefix) against a fake WDA_ROOT holding a stub store_cli.py.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wocoo_launcher.py')

STUB = r'''
import json, sys
args = sys.argv[1:]
if args[0] == 'fail':
    print(json.dumps({"ok": False, "error": "boom"}))
    sys.exit(1)
if args[0] == 'crash':
    sys.stderr.write("Traceback: kaput")
    sys.exit(2)
if args[0] == 'nothing':
    print("null")
elif args[0] == 'get':
    print(json.dumps({"key": args[2]}))
elif args[0] == 'list-ready':
    print(json.dumps({"items": [{"key": "WOCOO-1"}]}))
elif args[0] == 'outcome':
    print(json.dumps({"ok": True, "echo": json.loads(sys.stdin.read())}))
elif args[0] == 'i2c-activity':
    print(json.dumps({"ok": True, "ts": float(args[2])}))
elif args[0] == 'lesson-add':
    print(json.dumps({"ok": True, "id": "L1", "merged": False, "echo": json.loads(sys.stdin.read())}))
elif args[0] in ('solve', 'item'):
    print(json.dumps({"ok": True, "key": args[2], "state": "queued", "solo": args[0] == 'solve'}))
elif args[0] == 'agent-mode':
    mode = args[2] if len(args) > 2 and args[1] == '--set' else 'running'
    print(json.dumps({"ok": True, "mode": mode, "since": 1700000000.5 if len(args) > 2 else None}))
'''


def call(message, root):
    payload = json.dumps(message).encode('utf-8')
    env = dict(os.environ, WDA_ROOT=root)
    proc = subprocess.run([sys.executable, HOST], input=struct.pack('<I', len(payload)) + payload,
                          capture_output=True, env=env, timeout=20)
    out = proc.stdout
    length = struct.unpack('<I', out[:4])[0]
    assert len(out) == 4 + length, 'reply must be one length-prefixed frame'
    return json.loads(out[4:].decode('utf-8'))


class DraftActions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, 'src'))
        with open(os.path.join(self.root, 'src', 'store_cli.py'), 'w') as f:
            f.write(STUB)

    def tearDown(self):
        self.tmp.cleanup()

    def test_draft_get_shells_to_store_cli(self):
        reply = call({'action': 'draft_get', 'key': 'WOCOO-1'}, self.root)
        self.assertEqual(reply, {'ok': True, 'draft': {'key': 'WOCOO-1'}})

    def test_draft_get_null(self):
        # a stub that prints `null` for any command: reuse via a key the stub does not special-case
        with open(os.path.join(self.root, 'src', 'store_cli.py'), 'w') as f:
            f.write('print("null")\n')
        self.assertEqual(call({'action': 'draft_get', 'key': 'X-1'}, self.root),
                         {'ok': True, 'draft': None})

    def test_draft_get_requires_key(self):
        reply = call({'action': 'draft_get'}, self.root)
        self.assertFalse(reply['ok'])

    def test_draft_list_unwraps_items(self):
        self.assertEqual(call({'action': 'draft_list'}, self.root),
                         {'ok': True, 'items': [{'key': 'WOCOO-1'}]})

    def test_draft_outcome_pipes_row_on_stdin(self):
        row = {'key': 'WOCOO-1', 'draft_text': 'hi'}
        self.assertEqual(call({'action': 'draft_outcome', 'row': row}, self.root), {'ok': True})

    def test_i2c_activity_passes_ts(self):
        self.assertEqual(call({'action': 'i2c_activity', 'ts': 1700000000}, self.root), {'ok': True})

    def test_agent_mode_get(self):
        self.assertEqual(call({'action': 'agent_mode_get'}, self.root),
                         {'ok': True, 'mode': 'running', 'since': None})

    def test_agent_mode_set_passes_mode(self):
        self.assertEqual(call({'action': 'agent_mode_set', 'mode': 'paused'}, self.root),
                         {'ok': True, 'mode': 'paused', 'since': 1700000000.5})

    def test_agent_mode_set_rejects_invalid_mode(self):
        for message in ({'action': 'agent_mode_set', 'mode': 'sleeping'}, {'action': 'agent_mode_set'}):
            self.assertEqual(call(message, self.root),
                             {'ok': False, 'error': 'agent_mode_set needs mode running or paused'})

    def test_lesson_add_passes_the_lesson(self):
        reply = call({'action': 'lesson_add', 'lesson': {'text': 'Keep it short.', 'status': 'kept'}}, self.root)
        self.assertEqual((reply['ok'], reply['id'], reply['echo']['text']), (True, 'L1', 'Keep it short.'))
        self.assertEqual(call({'action': 'lesson_add'}, self.root),
                         {'ok': False, 'error': 'lesson_add needs a lesson object'})

    def test_agent_solve_and_item(self):
        self.assertEqual(call({'action': 'agent_solve', 'key': 'PROJ-12'}, self.root),
                         {'ok': True, 'key': 'PROJ-12', 'state': 'queued', 'solo': True})
        self.assertEqual(call({'action': 'agent_item', 'key': 'PROJ-12'}, self.root)['state'], 'queued')

    def test_agent_solve_rejects_a_bad_key(self):
        for key in (None, 'proj-1', 'PROJ 1; rm -rf /'):
            self.assertEqual(call({'action': 'agent_solve', 'key': key}, self.root),
                             {'ok': False, 'error': 'agent_solve needs a ticket key'})

    def test_agent_mode_cli_failure_returns_error(self):
        with open(os.path.join(self.root, 'src', 'store_cli.py'), 'w') as f:
            f.write('import sys\nprint(\'{"ok": false, "error": "boom"}\')\nsys.exit(1)\n')
        reply = call({'action': 'agent_mode_get'}, self.root)
        self.assertFalse(reply['ok'])
        self.assertIn('boom', reply['error'])

    def test_store_cli_failure_returns_error(self):
        with open(os.path.join(self.root, 'src', 'store_cli.py'), 'w') as f:
            f.write('import sys\nprint(\'{"ok": false, "error": "boom"}\')\nsys.exit(1)\n')
        reply = call({'action': 'draft_get', 'key': 'WOCOO-1'}, self.root)
        self.assertFalse(reply['ok'])
        self.assertIn('boom', reply['error'])

    def test_store_cli_crash_surfaces_stderr(self):
        with open(os.path.join(self.root, 'src', 'store_cli.py'), 'w') as f:
            f.write('import sys\nsys.stderr.write("kaput")\nsys.exit(2)\n')
        reply = call({'action': 'draft_list'}, self.root)
        self.assertFalse(reply['ok'])
        self.assertIn('kaput', reply['error'])

    def test_missing_store_cli_returns_error(self):
        reply = call({'action': 'draft_list'}, os.path.join(self.root, 'nope'))
        self.assertFalse(reply['ok'])

    def test_unknown_action_still_errors(self):
        reply = call({'action': 'nope'}, self.root)
        self.assertFalse(reply['ok'])
        self.assertIn('Unknown action', reply['error'])

    def test_ping_still_works(self):
        self.assertEqual(call({'action': 'ping'}, self.root), {'ok': True, 'pong': True})


if __name__ == '__main__':
    unittest.main()
