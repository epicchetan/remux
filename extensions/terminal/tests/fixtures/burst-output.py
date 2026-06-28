#!/usr/bin/env python3
import argparse
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bytes", default=1024 * 1024, type=int)
    parser.add_argument("--chunk", default=4096, type=int)
    args = parser.parse_args()

    total = max(0, args.bytes)
    chunk_size = max(1, args.chunk)
    written = 0
    seed = b"remux-terminal-burst "

    print(f"burst-start bytes={total}", flush=True)
    while written < total:
        remaining = total - written
        payload = (seed * ((min(chunk_size, remaining) // len(seed)) + 1))[:min(chunk_size, remaining)]
        sys.stdout.buffer.write(payload)
        written += len(payload)
    sys.stdout.buffer.write(b"\nburst-done\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
