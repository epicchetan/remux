#!/usr/bin/env python3
import sys
import termios
import tty


ARROWS = {
    b"\x1b[A": "up",
    b"\x1b[B": "down",
    b"\x1b[C": "right",
    b"\x1b[D": "left",
}


def main():
    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)

    sys.stdout.write("\x1b[?1049h")
    sys.stdout.flush()
    tty.setraw(fd)
    print("alternate-screen-ready", flush=True)

    try:
        buffer = b""
        while True:
            data = sys.stdin.buffer.read(1)
            if not data:
                break

            if data == b"q":
                print("alternate-screen-exit", flush=True)
                break

            buffer += data
            for sequence, name in ARROWS.items():
                if buffer.endswith(sequence):
                    print(f"arrow {name}", flush=True)
                    buffer = b""
                    break

            if len(buffer) > 8:
                print("bytes " + buffer.hex(), flush=True)
                buffer = b""
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, original)
        sys.stdout.write("\x1b[?1049l")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
