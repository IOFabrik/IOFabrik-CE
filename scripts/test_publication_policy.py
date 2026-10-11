"""Exercise the publication guard against real staged files, including forced adds."""

import pathlib
import subprocess
import sys
import tempfile
import unittest


CHECK = pathlib.Path(__file__).with_name('check-publication.py').resolve()


class PublicationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = pathlib.Path(self.directory.name)
        self.git('init', '-q')

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True)

    def stage(self, name, text='synthetic fixture only\n'):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        self.git('add', '-f', '--', name)

    def check(self):
        return subprocess.run([sys.executable, str(CHECK), '--repo', str(self.repo)], capture_output=True, text=True)

    def test_public_source_templates_and_verification_keys_remain_allowed(self):
        for name in ['main.go', 'frontend/.env.example', 'frontend/.env.production.example',
                     'build/windows/icon.ico', 'build/darwin/Info.plist',
                     'services/testdata/example.json', 'verification.pub',
                     'frontend/bindings/iofabrik/services/models.ts', 'LICENSE']:
            self.stage(name)
        self.assertEqual(self.check().returncode, 0)

    def test_forced_add_cannot_bypass_ignore_rules_and_does_not_print_contents(self):
        self.stage('.gitignore', '.env*\n.secrets/\n')
        sentinel = 'DO_NOT_PRINT_THIS_SYNTHETIC_VALUE'
        for name in ['.env', 'frontend/.env.production', '.secrets/signing.key']:
            self.stage(name, sentinel)
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn('frontend/.env.production', result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)

    def test_private_documents_and_binaries_are_rejected(self):
        for name in ['changeme', 'services.test.exe', 'build/.DS_Store',
                     'docs/.obsidian/workspace.json', 'docs/plans/Working Plan.md',
                     'docs/audit/review.md', 'docs/technical/archive/old.md',
                     'docs/processes/Release Process.md', 'backup.bundle',
                     'GitStuckStates.md', 'docs/COLLABORATION_SPEC.md',
                     'docs/technical/creating_a_viewer.md']:
            self.stage(name)
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn('docs/plans/Working Plan.md', result.stderr)

    def test_untracked_local_configuration_is_not_reported(self):
        (self.repo / '.env.local').write_text('synthetic local configuration')
        self.stage('README.md')
        self.assertEqual(self.check().returncode, 0)

    def test_missing_repository_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(CHECK), '--repo', directory], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
