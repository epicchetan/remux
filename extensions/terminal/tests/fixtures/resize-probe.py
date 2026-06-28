#!/usr/bin/env python3
import fcntl
import signal
import struct
import sys
import termios
import time


def terminal_size():
    packed = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
    rows, cols, _xpixels, _ypixels = struct.unpack("HHHH", packed)
    return rows, cols


def print_size(label):
    rows, cols = terminal_size()
    print(f"{label} rows={rows} cols={cols}", flush=True)


def handle_resize(_signal_number, _frame):
    print_size("resize")


def main():
    signal.signal(signal.SIGWINCH, handle_resize)
    print_size("initial")
    print("resize-probe-ready", flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("resize-probe-exit", flush=True)


if __name__ == "__main__":
    main()
