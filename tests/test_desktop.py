"""Run with RDV_TEST_DESKTOP=1 on a real desktop or Xvfb on the target platform."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/native'))


@unittest.skipUnless(os.environ.get('RDV_TEST_DESKTOP') == '1', 'Desktop tests require an explicit display session')
class DesktopTests(unittest.TestCase):
    def setUp(self):
        from desktop import Desktop
        from launcher import Application, Service
        self.directory = tempfile.TemporaryDirectory()
        self.app = Application(ROOT / 'dist', ROOT / 'vendor/force', self.directory.name)
        self.service = Service(self.app)
        self.desktop = Desktop('test')
        self.desktop.attach(self.service)
        self.desktop.root.update()

    def tearDown(self):
        self.service.close(); self.desktop.close(); self.directory.cleanup()

    def test_visible_window_language_reactivation_and_close(self):
        self.assertTrue(self.desktop.root.winfo_viewable())
        self.assertIn('Robot Data Viewer', self.desktop.root.title())
        self.desktop.toggle_language()
        self.assertTrue(self.desktop.status.get())
        self.desktop.root.iconify(); self.desktop.root.update()
        self.assertFalse(self.app.stop_event.is_set())
        with patch('desktop.webbrowser.open', return_value=True) as browser:
            self.desktop.activate(); self.desktop.root.update()
            self.assertTrue(self.desktop.root.winfo_viewable())
            browser.assert_called_once_with(self.service.url)
        # Invoke the actual window-manager close protocol, not a separate exit path.
        self.desktop.root.tk.call(self.desktop.root.protocol('WM_DELETE_WINDOW'))
        self.assertTrue(self.service.done.wait(5))

    def test_close_confirmation_keeps_service_alive_when_declined(self):
        self.app.session('test-browser-session', True)
        with patch('desktop.messagebox.askyesno', return_value=False) as confirm:
            self.desktop.stop(); confirm.assert_called_once()
        self.assertFalse(self.app.stop_event.is_set())
        with patch('desktop.messagebox.askyesno', return_value=True): self.desktop.stop()
        self.assertTrue(self.service.done.wait(5))

    def test_failed_browser_open_keeps_controls_available(self):
        with patch('desktop.webbrowser.open', return_value=False), patch('desktop.messagebox.showinfo') as notice:
            self.desktop.open(); notice.assert_called_once()
        self.assertFalse(self.app.stop_event.is_set())
        self.desktop.copy()
        self.assertEqual(self.desktop.root.clipboard_get(), self.service.url)


if __name__ == '__main__': unittest.main()
