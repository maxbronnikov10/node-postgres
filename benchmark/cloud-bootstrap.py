#!/usr/bin/env python3
"""Configure only disposable PostgreSQL services owned by the benchmark job."""

import argparse
import os
from pathlib import Path
import subprocess


class Fixture:
    def __init__(self, options):
        self.options = options
        self.directory = Path(options.tls_directory)

    def run(self, command):
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def configure(self):
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(self.directory / "ca.key"), "-out", str(self.directory / "ca.crt"),
            "-days", "2", "-subj", "/CN=nodepg-cloud-benchmark-ca",
        ])
        self.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(self.directory / "untrusted.key"), "-out", str(self.directory / "untrusted.crt"),
            "-days", "2", "-subj", "/CN=nodepg-untrusted-benchmark-ca",
        ])
        self.run([
            "openssl", "req", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(self.directory / "server.key"), "-out", str(self.directory / "server.csr"),
            "-subj", "/CN=localhost",
        ])
        (self.directory / "server.ext").write_text(
            "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
        )
        self.run([
            "openssl", "x509", "-req", "-in", str(self.directory / "server.csr"),
            "-CA", str(self.directory / "ca.crt"), "-CAkey", str(self.directory / "ca.key"),
            "-CAcreateserial", "-out", str(self.directory / "server.crt"), "-days", "2",
            "-extfile", str(self.directory / "server.ext"),
        ])
        for item in self.directory.iterdir():
            os.chmod(item, 0o600)
        self.configure_service(self.options.rw, "off")
        if self.options.ro:
            self.configure_service(self.options.ro, "on")

    def configure_service(self, container, read_only):
        for name in ["server.key", "server.crt", "ca.crt"]:
            self.run(["docker", "cp", str(self.directory / name), f"{container}:/tmp/nodepg-ha-{name}"])
        self.run([
            "docker", "exec", "-u", "0", container, "chown", "postgres:postgres",
            "/tmp/nodepg-ha-server.key", "/tmp/nodepg-ha-server.crt", "/tmp/nodepg-ha-ca.crt",
        ])
        statements = [
            "SET default_transaction_read_only=off",
            "ALTER SYSTEM SET ssl='on'",
            "ALTER SYSTEM SET ssl_cert_file='/tmp/nodepg-ha-server.crt'",
            "ALTER SYSTEM SET ssl_key_file='/tmp/nodepg-ha-server.key'",
            f"ALTER SYSTEM SET default_transaction_read_only='{read_only}'",
            "SELECT pg_reload_conf()",
        ]
        command = ["docker", "exec", container, "psql", "-q", "-U", "postgres", "-d", "nodepg_ha"]
        for statement in statements:
            command += ["-c", statement]
        self.run(command)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rw", required=True)
    parser.add_argument("--ro")
    parser.add_argument("--tls-directory", required=True)
    Fixture(parser.parse_args()).configure()
    print("Disposable PostgreSQL TLS fixture configured; durability defaults retained")
