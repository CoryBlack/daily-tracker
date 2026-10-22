#!/bin/sh
# Runs the logic + sync tests with macOS's built-in JavaScriptCore shell.
cd "$(dirname "$0")/.."
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
exec "$JSC" js/dates.js js/model.js js/sync.js tests/logic.test.js
