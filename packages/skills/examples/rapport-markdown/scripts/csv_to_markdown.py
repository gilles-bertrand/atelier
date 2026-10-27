#!/usr/bin/env python3
"""Convertit un CSV en tableau Markdown (nombres au format français).

Usage :
  python3 csv_to_markdown.py fichier.csv [--columns a,b] [--max-rows 50]
                             [--decimals 2] [--delimiter ';']
"""
from __future__ import annotations

import argparse
import csv
import sys


def parse_number(value: str) -> float | None:
    """Reconnaît 1234.5, 1 234,5, 1234,50 € ou 12 % ; None sinon."""
    text = value.strip().replace("\u00a0", "").replace(" ", "").rstrip("€%").strip()
    if not text:
        return None
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") else text.replace(",", "")
    else:
        text = text.replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def format_number(number: float, decimals: int | None) -> str:
    if decimals is None:
        decimals = 0 if number.is_integer() else 2
    text = f"{number:,.{decimals}f}"
    return text.replace(",", "\u202f").replace(".", ",")


def escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip()


def sniff_delimiter(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t").delimiter
    except csv.Error:
        return ","


def to_markdown(rows: list[list[str]], decimals: int | None) -> str:
    header, body = rows[0], rows[1:]
    numeric = [
        bool(body) and all(parse_number(r[i]) is not None for r in body if i < len(r) and r[i].strip())
        for i in range(len(header))
    ]
    lines = [
        "| " + " | ".join(escape_cell(h) for h in header) + " |",
        "| " + " | ".join("---:" if n else "---" for n in numeric) + " |",
    ]
    for row in body:
        cells = []
        for i in range(len(header)):
            value = row[i] if i < len(row) else ""
            number = parse_number(value) if numeric[i] else None
            if number is None:
                cells.append(escape_cell(value))
            else:
                suffix = "\u202f%" if value.strip().endswith("%") else "\u202f€" if value.strip().endswith("€") else ""
                cells.append(format_number(number, decimals) + suffix)
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="CSV → tableau Markdown")
    parser.add_argument("csv")
    parser.add_argument("--columns", help="colonnes à garder, séparées par des virgules")
    parser.add_argument("--max-rows", type=int, default=50)
    parser.add_argument("--decimals", type=int)
    parser.add_argument("--delimiter")
    args = parser.parse_args()

    try:
        with open(args.csv, newline="", encoding="utf-8-sig") as handle:
            sample = handle.read(4096)
            handle.seek(0)
            rows = list(csv.reader(handle, delimiter=args.delimiter or sniff_delimiter(sample)))
    except UnicodeDecodeError:
        with open(args.csv, newline="", encoding="latin-1") as handle:
            sample = handle.read(4096)
            handle.seek(0)
            rows = list(csv.reader(handle, delimiter=args.delimiter or sniff_delimiter(sample)))
    except OSError as error:
        print(f"Erreur : {error}", file=sys.stderr)
        return 1

    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        print("Erreur : CSV vide.", file=sys.stderr)
        return 1
    if args.columns:
        wanted = [c.strip() for c in args.columns.split(",")]
        missing = [c for c in wanted if c not in rows[0]]
        if missing:
            print(f"Erreur : colonnes inconnues : {', '.join(missing)}", file=sys.stderr)
            return 1
        indexes = [rows[0].index(c) for c in wanted]
        rows = [[r[i] if i < len(r) else "" for i in indexes] for r in rows]

    total = len(rows) - 1
    print(to_markdown(rows[: args.max_rows + 1], args.decimals))
    if total > args.max_rows:
        print(f"\n_{args.max_rows} lignes affichées sur {total}._")
    return 0


if __name__ == "__main__":
    sys.exit(main())
