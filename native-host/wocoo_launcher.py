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

Installed by install.sh, which registers the host manifest with Chrome.
"""

import json
import os
import struct
import subprocess
import sys

DEFAULT_TOOL_COMMAND = os.path.expanduser('~/Documents/interest-tool/Start App.command')


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
    else:
        send_message({'ok': False, 'error': f'Unknown action: {action!r}'})


if __name__ == '__main__':
    main()
