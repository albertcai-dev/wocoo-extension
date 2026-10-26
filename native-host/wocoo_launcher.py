#!/usr/bin/env python3
"""Native messaging host for the WOCOO Triager extension.

Chrome extensions can't execute local files, so the side panel talks to this
script over Chrome's native messaging protocol (4-byte little-endian length
prefix + JSON payload on stdin/stdout). Chrome spawns it per message and it
exits after replying.

Actions:
  {"action": "ping"}                    -> {"ok": true, "pong": true}
  {"action": "launch_interest_tool"}    -> runs `open "Start App.command"`
        optional "path" overrides the default tool location.
  {"action": "draft_get", "key": K}     -> {"ok": true, "draft": {...}|null}
  {"action": "draft_list"}              -> {"ok": true, "items": [...]}
  {"action": "draft_outcome", "row": R} -> {"ok": true}
  {"action": "lesson_add", "lesson": L}  -> {"ok": true, "id": I, "merged": bool}
        L = {"text", "status": "kept"|"wrong", "work_type"?, "category"?, "source_key"?}
  {"action": "i2c_activity", "ts": T}   -> {"ok": true}
  {"action": "agent_mode_get"}          -> {"ok": true, "mode": "running"|"paused", "since": N|null}
  {"action": "agent_mode_set", "mode": M}  (M is "running" or "paused") -> same reply as agent_mode_get
  {"action": "agent_solve", "key": K}   -> {"ok": true, "key": K, "state": S, "solo": bool}
        draft this ticket now; a paused agent runs for this ticket only, then pauses itself
  {"action": "agent_item", "key": K}    -> {"ok": true, "key": K, "state": S|null, "solo": bool, "priority": bool}
  {"action": "agent_status"}            -> the agent's status dict, passed through unchanged
        The draft_* / i2c_activity / agent_mode_* actions shell out to the local draft agent's store CLI:
        `python3 $WDA_ROOT/src/store_cli.py ...` (WDA_ROOT defaults to ~/projects/wocoo-draft-agent).

Installed by install.sh, which registers the host manifest with Chrome.
"""

import json
import os
import re
import struct
import subprocess
import sys

DEFAULT_TOOL_COMMAND = os.path.expanduser('~/Documents/interest-tool/Start App.command')
DEFAULT_WDA_ROOT = '~/projects/wocoo-draft-agent'
STORE_TIMEOUT_S = 5


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack('<I', raw_length)[0]
    payload = sys.stdin.buffer.read(length)
    return json.loads(payload.decode('utf-8'))


def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def launch(path):
    if not os.path.isfile(path):
        return {'ok': False, 'error': f'Not found: {path}'}
    # `open` hands the .command to Terminal — same as double-clicking it in Finder,
    # so the agent still sees setup progress and can Ctrl+C to stop the app.
    result = subprocess.run(['/usr/bin/open', path], capture_output=True, text=True)
    if result.returncode != 0:
        return {'ok': False, 'error': (result.stderr or 'open failed').strip()}
    return {'ok': True, 'launched': path}


def run_store(args, stdin=None):
    """Runs store_cli.py and returns (parsed stdout JSON, None) or (None, error message)."""
    root = os.path.expanduser(os.environ.get('WDA_ROOT') or DEFAULT_WDA_ROOT)
    cli = os.path.join(root, 'src', 'store_cli.py')
    if not os.path.isfile(cli):
        return None, f'Not found: {cli}'
    try:
        result = subprocess.run([sys.executable, cli, *args], input=stdin, capture_output=True,
                                text=True, timeout=STORE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None, f'store_cli timed out after {STORE_TIMEOUT_S}s'
    except OSError as exc:
        return None, f'store_cli could not run: {exc}'
    out = (result.stdout or '').strip()
    if result.returncode != 0:
        detail = ''
        try:
            parsed = json.loads(out)
            if isinstance(parsed, dict):
                detail = parsed.get('error') or '; '.join(parsed.get('errors') or [])
        except ValueError:
            pass
        detail = detail or (result.stderr or out or f'exit {result.returncode}').strip()
        return None, f'store_cli failed: {detail}'
    try:
        return json.loads(out), None
    except ValueError:
        return None, f'store_cli returned non-JSON output: {out[:200]}'


def draft_action(action, message):
    if action == 'draft_get':
        key = message.get('key')
        if not isinstance(key, str) or not key:
            return {'ok': False, 'error': 'draft_get needs a key'}
        data, err = run_store(['get', '--key', key])
        return {'ok': False, 'error': err} if err else {'ok': True, 'draft': data}
    if action == 'draft_list':
        data, err = run_store(['list-ready'])
        if err:
            return {'ok': False, 'error': err}
        items = data.get('items') if isinstance(data, dict) else data
        return {'ok': True, 'items': items if isinstance(items, list) else []}
    if action == 'draft_outcome':
        row = message.get('row')
        if not isinstance(row, dict):
            return {'ok': False, 'error': 'draft_outcome needs a row object'}
        _, err = run_store(['outcome'], stdin=json.dumps(row))
        return {'ok': False, 'error': err} if err else {'ok': True}
    if action == 'lesson_add':
        lesson = message.get('lesson')
        if not isinstance(lesson, dict):
            return {'ok': False, 'error': 'lesson_add needs a lesson object'}
        data, err = run_store(['lesson-add'], stdin=json.dumps(lesson))
        if err:
            return {'ok': False, 'error': err}
        return data if isinstance(data, dict) else {'ok': False, 'error': 'bad store reply'}
    if action in ('agent_mode_get', 'agent_mode_set'):
        args = ['agent-mode']
        if action == 'agent_mode_set':
            mode = message.get('mode')
            if mode not in AGENT_MODES:
                return {'ok': False, 'error': 'agent_mode_set needs mode running or paused'}
            args += ['--set', mode]
        data, err = run_store(args)
        if err:
            return {'ok': False, 'error': err}
        data = data if isinstance(data, dict) else {}
        return {'ok': True, 'mode': data.get('mode'), 'since': data.get('since')}
    if action in ('agent_solve', 'agent_item'):
        key = message.get('key')
        if not isinstance(key, str) or not TICKET_KEY.match(key):
            return {'ok': False, 'error': f'{action} needs a ticket key'}
        data, err = run_store(['solve' if action == 'agent_solve' else 'item', '--key', key])
        if err:
            return {'ok': False, 'error': err}
        return data if isinstance(data, dict) else {'ok': False, 'error': 'bad store reply'}
    if action == 'agent_status':
        data, err = run_store(['status'])
        if err:
            return {'ok': False, 'error': err}
        return data if isinstance(data, dict) else {'ok': False, 'error': 'bad store reply'}
    ts = message.get('ts')
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return {'ok': False, 'error': 'i2c_activity needs a numeric ts'}
    _, err = run_store(['i2c-activity', '--ts', repr(float(ts))])
    return {'ok': False, 'error': err} if err else {'ok': True}


AGENT_MODES = ('running', 'paused')
TICKET_KEY = re.compile(r'^[A-Z][A-Z0-9]+-\d+$')
DRAFT_ACTIONS = ('draft_get', 'draft_list', 'draft_outcome', 'lesson_add', 'i2c_activity',
                 'agent_mode_get', 'agent_mode_set', 'agent_solve', 'agent_item', 'agent_status')


def main():
    try:
        message = read_message()
    except Exception as exc:  # malformed frame — reply so the extension isn't left hanging
        send_message({'ok': False, 'error': f'Bad request: {exc}'})
        return
    if message is None:
        return

    action = message.get('action')
    if action == 'ping':
        send_message({'ok': True, 'pong': True})
    elif action == 'launch_interest_tool':
        path = os.path.expanduser(message.get('path') or DEFAULT_TOOL_COMMAND)
        send_message(launch(path))
    elif action in DRAFT_ACTIONS:
        send_message(draft_action(action, message))
    else:
        send_message({'ok': False, 'error': f'Unknown action: {action!r}'})


if __name__ == '__main__':
    main()
