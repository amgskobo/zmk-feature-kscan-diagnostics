#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Setting up the development environment..."
echo "* Current directory: $(pwd)"
python3 tools/verify_review_dependencies.py

if ! west topdir &> /dev/null; then
    echo "* Initializing West..."
    west init -l west --mf west-test-isolated.yml
else
    echo "* West is already initialized with topdir: $(west topdir)"
fi
west update --narrow
west zephyr-export
npm --prefix web ci
pre-commit install-hooks

git config --global --add safe.directory "$(pwd)"
pre-commit install
