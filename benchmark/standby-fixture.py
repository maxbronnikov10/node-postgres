#!/usr/bin/env python3
"""Create disposable physical-replication fixtures; cleanup is intentionally separate."""

import argparse
import json
from pathlib import Path
import subprocess
import time


class PhysicalStandbySetup:
    network = "nodepg-physical-20261114"
    primary = "nodepg-physical-rw-20261114"
    standby = "nodepg-physical-standby-20261114"
    image = "postgres@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95"

    def __init__(self, output):
        self.output = Path(output)

    def docker(self, args, *, timeout=30, input=None):
        return subprocess.run(
            ["sudo", "-n", "docker", *args],
            input=input,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=True,
        )

    def assert_unused_names(self):
        containers = self.docker(["container", "ls", "-a", "--format", "{{.Names}}"]).stdout.splitlines()
        networks = self.docker(["network", "ls", "--format", "{{.Name}}"]).stdout.splitlines()
        if self.primary in containers or self.standby in containers or self.network in networks:
            raise RuntimeError("Fixture names already exist; refusing to replace or delete existing resources")

    def wait_ready(self, container):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                self.docker(
                    [
                        "exec", container, "pg_isready", "-h", "127.0.0.1",
                        "-U", "postgres", "-d", "nodepg_physical", "-t", "2",
                    ],
                    timeout=5,
                )
                return
            except subprocess.CalledProcessError:
                time.sleep(0.5)
        raise RuntimeError(f"PostgreSQL readiness deadline exceeded: {container}")

    def published_port(self, container):
        ports = json.loads(
            self.docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]).stdout
        )
        bindings = ports["5432/tcp"]
        if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
            raise RuntimeError(f"Expected one localhost PostgreSQL binding: {container}")
        port = int(bindings[0]["HostPort"])
        if not 0 < port <= 65535:
            raise RuntimeError(f"Invalid published PostgreSQL port: {container}")
        return port

    def run(self):
        self.assert_unused_names()
        # Internal networks suppress host-published ports on this Docker setup.
        self.docker(["network", "create", "--driver", "bridge", self.network])
        self.docker(
            [
                "run", "-d", "--name", self.primary, "--network", self.network,
                "-p", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                "-e", "POSTGRES_DB=nodepg_physical", "-e", "PGDATA=/tmp/pgdata",
                self.image, "postgres", "-c", "wal_level=replica", "-c", "max_wal_senders=2",
            ],
            timeout=180,
        )
        self.wait_ready(self.primary)
        self.docker(
            ["exec", "-u", "postgres", "-i", self.primary, "sh", "-c", 'cat >> "$PGDATA/pg_hba.conf"'],
            input="\nhost replication postgres 0.0.0.0/0 trust\n",
        )
        self.docker(["exec", "-u", "postgres", self.primary, "pg_ctl", "-D", "/tmp/pgdata", "reload"])
        self.docker(
            [
                "run", "-d", "--name", self.standby, "--network", self.network,
                "-p", "127.0.0.1::5432", "--user", "postgres", "-e", "PGDATA=/tmp/pgdata",
                "--entrypoint", "sh", self.image, "-c",
                f'pg_basebackup -h {self.primary} -U postgres -D "$PGDATA" -R -X stream'
                ' && exec postgres -D "$PGDATA"',
            ],
            timeout=180,
        )
        self.wait_ready(self.standby)
        metadata = {
            "network": self.network,
            "primary": self.primary,
            "standby": self.standby,
            "primaryPort": self.published_port(self.primary),
            "standbyPort": self.published_port(self.standby),
            "image": self.image,
        }
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(metadata, separators=(",", ":")))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="fixture metadata JSON path")
    PhysicalStandbySetup(parser.parse_args().output).run()
