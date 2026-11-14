#!/usr/bin/env python3
"""Create a loopback-only, disposable PgBouncer transaction/TLS fixture."""

import argparse
import json
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time


class PoolerFixture:
    image = "postgres@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95"

    def __init__(self, options):
        self.options = options
        if not re.fullmatch(r"nodepg-[a-zA-Z0-9_.-]+", options.container):
            raise ValueError("An explicitly named nodepg- fixture container is required")
        for port in (options.postgres_port, options.listen_port):
            if not 0 < port <= 65535:
                raise ValueError("Fixture ports must be between 1 and 65535")
        if options.postgres_port == options.listen_port:
            raise ValueError("Fixture ports must differ")
        self.tls = Path(options.tls_directory).resolve()
        for name in ("server.key", "server.crt", "ca.crt"):
            if not (self.tls / name).is_file():
                raise ValueError(f"Missing fixture TLS file: {name}")

    def run(self, args, *, timeout=120):
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        return result.stdout.strip()

    def configure(self):
        container = self.options.container
        self.run([
            "docker", "run", "--rm", "--name", container, "--network", "host",
            "--entrypoint", "sleep", "-d", self.image, "infinity",
        ])
        self.run(["docker", "exec", "-u", "0", container, "apk", "add", "--no-cache", "pgbouncer=1.25.2-r0"])
        self.run(["docker", "exec", "-u", "0", container, "mkdir", "-p", "/tmp/nodepg-pgbouncer"])
        for name in ("server.key", "server.crt", "ca.crt"):
            self.run(["docker", "cp", str(self.tls / name), f"{container}:/tmp/nodepg-pgbouncer/{name}"])
        config = f"""[databases]
nodepg_tls = host=127.0.0.1 port={self.options.postgres_port} dbname=nodepg_ha user=postgres

[pgbouncer]
listen_addr=127.0.0.1
listen_port={self.options.listen_port}
unix_socket_dir=
auth_type=trust
auth_file=/tmp/nodepg-pgbouncer/users.txt
admin_users=postgres
pool_mode=transaction
default_pool_size=4
reserve_pool_size=0
max_client_conn=100
max_prepared_statements=200
client_tls_sslmode=require
client_tls_key_file=/tmp/nodepg-pgbouncer/server.key
client_tls_cert_file=/tmp/nodepg-pgbouncer/server.crt
client_tls_protocols=tlsv1.3
server_tls_sslmode=verify-full
server_tls_ca_file=/tmp/nodepg-pgbouncer/ca.crt
server_tls_protocols=tlsv1.3
pidfile=/tmp/nodepg-pgbouncer/pgbouncer.pid
logfile=/tmp/nodepg-pgbouncer/pgbouncer.log
"""
        with tempfile.TemporaryDirectory(prefix="nodepg-pgbouncer-") as directory:
            root = Path(directory)
            (root / "pgbouncer.ini").write_text(config)
            (root / "users.txt").write_text('"postgres" ""\n')
            for name in ("pgbouncer.ini", "users.txt"):
                self.run(["docker", "cp", str(root / name), f"{container}:/tmp/nodepg-pgbouncer/{name}"])
        self.run(["docker", "exec", "-u", "0", container, "chown", "-R", "postgres:postgres", "/tmp/nodepg-pgbouncer"])
        self.run(["docker", "exec", "-u", "0", container, "sh", "-c", "chmod 700 /tmp/nodepg-pgbouncer; chmod 600 /tmp/nodepg-pgbouncer/*"])
        self.run(["docker", "exec", "-u", "postgres", container, "pgbouncer", "-d", "/tmp/nodepg-pgbouncer/pgbouncer.ini"])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.options.listen_port), timeout=1):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("PgBouncer fixture did not become ready")
        version = self.run(["docker", "exec", "-u", "postgres", container, "pgbouncer", "--version"])
        metadata = {"version": version, "container": container, "port": self.options.listen_port, "database": "nodepg_tls", "poolMode": "transaction", "tls": "client require TLS1.3; backend verify-full TLS1.3"}
        output = Path(self.options.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(metadata, indent=2) + "\n")
        print(json.dumps(metadata))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--postgres-port", required=True, type=int)
    parser.add_argument("--listen-port", required=True, type=int)
    parser.add_argument("--tls-directory", required=True)
    parser.add_argument("--output", required=True)
    PoolerFixture(parser.parse_args()).configure()
