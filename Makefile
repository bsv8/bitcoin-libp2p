.PHONY: release-check

release-check:
	npm ci --prefix typescript
	node scripts/release-check.mjs
	(cd typescript && npm run build:integration)
	node scripts/test-framing-integration.mjs
	go test ./...
	go vet ./...
