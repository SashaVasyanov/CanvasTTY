#!/usr/bin/env python3
# CanvasTTY POSIX pty bridge (Linux/macOS). Same framing protocol as ptybridge.cs.
import os, sys, pty, struct, select, base64, fcntl, termios, signal

def b64(s):
    return '' if s in ('-', '') else base64.b64decode(s).decode('utf-8')

def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cwd, cmd = b64(sys.argv[3]), b64(sys.argv[4])
    if not cwd or not os.path.isdir(cwd):
        cwd = os.path.expanduser('~')
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        shell = os.environ.get('SHELL', '/bin/bash')
        os.execvp(shell, [shell, '-lc', cmd] if cmd else [shell, '-l'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    stdin = sys.stdin.buffer.raw if hasattr(sys.stdin.buffer, 'raw') else sys.stdin.buffer
    out = sys.stdout.buffer
    inbuf = b''
    infd = sys.stdin.fileno()
    while True:
        try:
            r, _, _ = select.select([fd, infd], [], [], 0.5)
        except InterruptedError:
            continue
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                break
            out.write(data); out.flush()
        if infd in r:
            chunk = os.read(infd, 65536)
            if not chunk:
                os.kill(pid, signal.SIGHUP); break
            inbuf += chunk
            while len(inbuf) >= 5:
                t, n = inbuf[0], struct.unpack('<i', inbuf[1:5])[0]
                if len(inbuf) < 5 + n: break
                payload, inbuf = inbuf[5:5 + n], inbuf[5 + n:]
                if t == 0:
                    os.write(fd, payload)
                elif t == 1:
                    c, rr = struct.unpack('<HH', payload[:4])
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rr, c, 0, 0))
                    os.kill(pid, signal.SIGWINCH)
                elif t == 2:
                    os.kill(pid, signal.SIGHUP)
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except Exception:
        code = 0
    sys.exit(code if code >= 0 else 1)

if __name__ == '__main__':
    main()
