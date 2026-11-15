SHELL := /bin/sh

connectionString=postgres://

params := $(connectionString)

node-command := xargs -n 1 -I file node file $(params)

.PHONY : test test-integration bench \
	 publish update-npm

all:
	npm install

help:
	@echo "make test-all [connectionString=postgres://<your connection string>]"

test: test-unit

test-all: test-unit test-integration


update-npm:
	@npm i npm --global

bench:
	@find benchmark -name "*-bench.js" | $(node-command)

test-unit:
	@chmod 600 test/unit/client/pgpass.file
	@find test/unit -name "*-tests.js" | $(node-command)

test-integration:
	@echo "***Testing Pure Javascript***"
	@find test/integration -name "*-tests.js" | $(node-command)

test-binary:
	@echo "***Testing Pure Javascript (binary)***"
	@find test/integration -name "*-tests.js" | $(node-command) binary

test-pool:
	@find test/integration/connection-pool -name "*.js" | $(node-command) binary
