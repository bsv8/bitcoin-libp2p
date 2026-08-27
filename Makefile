.PHONY: release-check

release-check:
	npm ci --prefix typescript
	node scripts/release-check.mjs
	go test ./...
	go vet ./...
