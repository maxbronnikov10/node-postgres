#!/usr/bin/env python3
"""Run the candidate's behavioral checks and retain every command's output."""

import argparse
import glob
import json
import os
from pathlib import Path
import re
import subprocess


class RegressionRun:
    def __init__(self, options):
        self.root = Path(options.head).resolve()
        self.output = Path(options.output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.results = []

    def check(self, name, directory, command):
        try:
            result = subprocess.run(
                command, cwd=directory, env=os.environ.copy(), stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, timeout=90,
            )
            code, text = result.returncode, result.stdout
        except subprocess.TimeoutExpired as error:
            code, text = 124, (error.stdout or b"").decode(errors="replace")
        (self.output / (name.replace("/", "__") + ".log")).write_text(text)
        text = re.sub(r"\x1b\[[0-9;]*m", "", text)
        match = re.search(r"(\d+) passing", text)
        tap = re.search(r"^# tests (\d+)$", text, re.M)
        cases = int(match[1]) if match else int(tap[1]) if tap else sum(
            "✔" in line and "skipping" not in line.lower() for line in text.splitlines()
        )
        if name == "typed-api":
            cases = 0
        if name == "workerd":
            vitest = re.search(r"Tests\s+(\d+) passed", text)
            cases = int(vitest[1]) if vitest else 0
        failed = code != 0 or "FAILED!" in text or bool(re.search(r"^not ok ", text, re.M))
        self.results.append({"name": name, "exit": code, "cases": cases, "failed": failed})
        (self.output / "checks.json").write_text(json.dumps(self.results, indent=2) + "\n")
        print(f"{name}: exit={code}, reported cases={cases}", flush=True)
        if failed:
            print(text[-6000:], flush=True)
            raise SystemExit(1)

    def run(self):
        package = self.root / "packages/pg"
        self.check("typed-api", self.root, [
            "node", str(self.root / "node_modules/typescript/bin/tsc"),
            "-p", "packages/pg/tsconfig.types.json", "--pretty", "false",
        ])
        # Git preserves only the executable bit, while pgpass requires a private file.
        (package / "test/unit/client/pgpass.file").chmod(0o600)
        files = [
            str(file.relative_to(package))
            for directory in ("test/unit", "test/integration")
            for file in (package / directory).rglob("*-tests.js")
            if file.is_file()
        ]
        for name in sorted(files):
            self.check(name, package, ["node", name])
        mocha = str(self.root / "node_modules/.bin/mocha")
        self.check("protocol", self.root, [
            mocha, *sorted(glob.glob(str(self.root / "packages/pg-protocol/dist/**/*.test.js"), recursive=True)),
            "--reporter", "dot",
        ])
        for name, path in [("pool", "pg-pool"), ("cursor", "pg-cursor")]:
            self.check(name, self.root / "packages" / path, [mocha, "--reporter", "dot"])
        self.check("stream", self.root / "packages/pg-query-stream", [
            mocha, "-r", "ts-node/register", "test/**/*.ts", "--reporter", "dot",
        ])
        for file in sorted((package / "test/native").glob("*-tests.js")):
            self.check("native-" + file.name, package, ["node", str(file)])
        self.check("workerd", package, [
            "node", str(self.root / "node_modules/vitest/vitest.mjs"), "run", "--config",
            "test/vitest.config.mts", "test/cloudflare/", "--watch=false",
        ])
        self.check("endpoint-tls", self.root, ["node", "benchmark/ha-tls-check.js"])
        self.check("benchmark-cli", self.root, ["node", "benchmark/queue-check.js", "."])
        print("Total reported cases:", sum(row["cases"] for row in self.results), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--head", required=True)
    parser.add_argument("--output", required=True)
    RegressionRun(parser.parse_args()).run()
