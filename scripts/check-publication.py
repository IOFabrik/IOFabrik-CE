#!/usr/bin/env python3
"""Reject private/local artifacts in Git's index; never read or print secrets."""

import argparse
import pathlib
import subprocess
import sys


PRIVATE_PREFIXES = (
    '.secrets/', 'build/certs/', 'build/deps/', 'bin/', 'release/',
    'test-updates/', 'frontend/dist/', 'docs/plans/', 'docs/audit/',
    'docs/technical/archive/', 'docs/Product Docs/',
)
PRIVATE_PATHS = {
    'changeme', 'iofabrik', 'controlzebra', 'services.test.exe', 'v2-frontend-ux-plan.md',
    'docs/Untitled.md', 'docs/product/ROADMAP.md',
    'docs/processes/Release Process.md', 'docs/processes/Incident Response.md',
    'GitStuckStates.md', '.github/frontend.md',
}
PRIVATE_DOCUMENT_NAMES = {'COLLABORATION_SPEC.md', 'REVISION_PLAN.md', 'ROADMAP.md', 'FILE_MANAGER_PLAN.md'}
PRIVATE_SUFFIXES = ('.key', '.pem', '.p12', '.pfx', '.keystore', '.bundle', '.test', '.test.exe', '.code-workspace')


def violation(path):
    parts = pathlib.PurePosixPath(path).parts
    name = parts[-1] if parts else ''
    if path in PRIVATE_PATHS or path.startswith(PRIVATE_PREFIXES):
        return 'private document or generated artifact'
    if path.startswith('docs/') and name in PRIVATE_DOCUMENT_NAMES:
        return 'internal planning document'
    if path.startswith('docs/technical/') and len(parts) == 3 and name.endswith('.md'):
        return 'legacy document location; use a current public documentation category'
    if any(part in {'.obsidian', '.secrets', 'node_modules', '__pycache__'} for part in parts):
        return 'local workspace or generated directory'
    if name in {'.DS_Store', 'Thumbs.db'}:
        return 'operating-system metadata'
    if name == '.env' or (name.startswith('.env.') and not name.endswith('.example')):
        return 'local environment configuration'
    if name.endswith(PRIVATE_SUFFIXES):
        return 'credential, recovery file, or local build output'
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='.', help='Repository whose Git index is checked')
    args = parser.parse_args()
    result = subprocess.run(
        ['git', '-C', args.repo, 'ls-files', '-z'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        print('Could not read the Git index; run this check inside a repository.', file=sys.stderr)
        return 2
    paths = result.stdout.decode('utf-8', errors='surrogateescape').split('\0')
    failures = [(path, violation(path)) for path in paths if path and violation(path)]
    if failures:
        print('Publication check failed. Keep these tracked files outside the public repository:', file=sys.stderr)
        for path, reason in failures:
            print(f'  {path!r}: {reason}', file=sys.stderr)
        return 1
    print('Publication check passed: no prohibited tracked paths.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
