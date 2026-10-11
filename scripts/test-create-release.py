#!/usr/bin/env python3
"""Release CLI regression tests; no network or real release publication."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name('create-release.sh')


class ReleaseCLITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.out = self.root / 'output'
        for name in ('iofabrik-windows-amd64.exe', 'iofabrik-amd64-installer.exe'):
            (self.bin / name).write_bytes(b'fixture')
        # The shell tests exercise fail-closed orchestration. PowerShell's actual
        # signature and checksum checks are covered by test-verify-release.ps1.
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        (self.tools / 'powershell').write_text('#!/bin/sh\necho "$@" >> "$CALL_LOG"\nexit "${VERIFY_STATUS:-0}"\n')
        (self.tools / 'gh').write_text('#!/bin/sh\necho "$@" >> "$UPLOAD_LOG"\n')
        for path in self.tools.iterdir():
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{self.tools}{os.pathsep}{os.environ["PATH"]}',
                        CALL_LOG=str(self.root / 'calls'), UPLOAD_LOG=str(self.root / 'uploads'))

    def run_release(self, *args):
        return subprocess.run(['bash', str(SCRIPT), '--version', '1.2.3', '--dir', str(self.bin),
                               '--output', str(self.out), *args], env=self.env, capture_output=True, text=True)

    def test_missing_and_wrong_names(self):
        for name in ('iofabrik-windows-amd64.exe', 'iofabrik-amd64-installer.exe'):
            with self.subTest(name=name):
                path = self.bin / name
                wrong = self.bin / ('wrong-' + name)
                path.rename(wrong)
                result = self.run_release('--upload')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Missing or empty artifact', result.stderr)
                self.assertFalse((self.root / 'uploads').exists())
                wrong.rename(path)

    def test_failed_verification_never_uploads(self):
        self.env['VERIFY_STATUS'] = '1'
        result = self.run_release('--upload')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'uploads').exists())

    def test_validate_only_does_not_rewrite(self):
        self.out.mkdir()
        marker = self.out / 'SHA256SUMS'
        marker.write_text('corrupt checksum')
        self.env['VERIFY_STATUS'] = '1'
        result = self.run_release('--validate-only', '--upload')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_text(), 'corrupt checksum')
        self.assertNotIn('-WriteChecksums', (self.root / 'calls').read_text())
        self.assertFalse((self.root / 'uploads').exists())

    def test_existing_output_is_preserved(self):
        self.out.mkdir()
        self.assertNotEqual(self.run_release().returncode, 0)
        self.assertFalse((self.root / 'calls').exists())

    def test_upload_targets_exact_contract(self):
        result = self.run_release('--upload', '--notes', 'Release notes')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.root / 'calls').read_text().splitlines()
        self.assertEqual(len(calls), 2)
        self.assertIn('-WriteChecksums', calls[0])
        upload = (self.root / 'uploads').read_text()
        self.assertIn('--repo IOFabrik/IOFabrik-CE', upload)
        for name in ('iofabrik-windows-amd64.exe', 'iofabrik-amd64-installer.exe', 'SHA256SUMS'):
            self.assertIn(name, upload)
        self.assertNotIn('update.json', upload)

    def test_invalid_version_and_missing_argument(self):
        for args in (('--version', '1.2.3-beta.1'), ('--version', 'v1.2.3'), ('--notes',)):
            with self.subTest(args=args):
                self.assertNotEqual(self.run_release(*args).returncode, 0)


if __name__ == '__main__':
    unittest.main()
