#!/usr/bin/env python3
import sys
import termios
import tty


def main():
    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)
    tty.setraw(fd)
    print("raw-input-ready", flush=True)

    try:
        while True:
            data = sys.stdin.buffer.read(1)
            if not data:
                break

            byte = data[0]
            print(f"{byte:02x}", flush=True)
            if byte == 4:
                break
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, original)


if __name__ == "__main__":
    main()
