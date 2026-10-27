"""Small desktop controller; Tk calls stay on the main thread."""
import locale
import tkinter as tk
from tkinter import messagebox, ttk
import webbrowser


WORDS = {
    'title': ('Robot Data Viewer', '机器人数据查看器'),
    'starting': ('Starting…', '正在启动…'),
    'running': ('Service running', '服务运行中'),
    'preparing': ('Preparing force results', '正在计算力数据'),
    'stopping': ('Stopping…', '正在停止…'),
    'open': ('Open Viewer', '打开查看器'),
    'copy': ('Copy launch address', '复制启动地址'),
    'stop': ('Stop & Exit', '停止并退出'),
    'hint': ('Closing this window stops the service. Closing browser tabs does not.', '关闭此窗口会停止服务。仅关闭浏览器标签页不会停止服务。'),
    'confirm': ('Force preparation is active. Cancel it and stop the viewer? Completed saved results will be kept.', '力数据正在计算。取消计算并退出查看器？已保存的完整结果会保留。'),
    'browser': ('Could not open a browser. Use Copy launch address and paste it into your browser.', '无法打开浏览器。请复制启动地址并粘贴到浏览器中。'),
}


class Desktop:
    def __init__(self, version):
        self.root = tk.Tk(className='RobotDataViewer')
        self.root.title('Robot Data Viewer ' + version)
        self.root.minsize(480, 220)
        self.root.resizable(True, False)
        self.language = int((locale.getlocale()[0] or '').lower().startswith('zh'))
        self.service = None
        self.closing = False
        self.status = tk.StringVar()
        self.address = tk.StringVar()
        frame = ttk.Frame(self.root, padding=22)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='Robot Data Viewer  ' + version, font=('TkDefaultFont', 15, 'bold')).pack(anchor='w')
        ttk.Label(frame, textvariable=self.status).pack(anchor='w', pady=(14, 8))
        ttk.Entry(frame, textvariable=self.address, state='readonly', width=54).pack(fill='x')
        buttons = ttk.Frame(frame)
        buttons.pack(fill='x', pady=14)
        self.open_button = ttk.Button(buttons, command=self.open)
        self.open_button.pack(side='left')
        self.copy_button = ttk.Button(buttons, command=self.copy)
        self.copy_button.pack(side='left', padx=8)
        self.stop_button = ttk.Button(buttons, command=self.stop)
        self.stop_button.pack(side='right')
        self.hint = ttk.Label(frame, wraplength=470)
        self.hint.pack(anchor='w')
        ttk.Button(frame, text='English / 中文', command=self.toggle_language).pack(anchor='e', pady=(10, 0))
        self.root.protocol('WM_DELETE_WINDOW', self.stop)
        self.root.createcommand('::tk::mac::Quit', self.stop) if self.root.tk.call('tk', 'windowingsystem') == 'aqua' else None
        self.refresh()

    def word(self, name):
        return WORDS[name][self.language]

    def toggle_language(self):
        self.language = 1 - self.language
        self.refresh()

    def refresh(self):
        for button, name in ((self.open_button, 'open'), (self.copy_button, 'copy'), (self.stop_button, 'stop')):
            button.configure(text=self.word(name))
        self.hint.configure(text=self.word('hint'))
        state = self.service.app.service_state() if self.service else {'state': 'starting', 'preparing': False}
        self.status.set(self.word('preparing' if state['state'] == 'running' and state['preparing'] else state['state']))
        available = bool(self.service and state['state'] == 'running')
        self.open_button.configure(state='normal' if available else 'disabled')
        self.copy_button.configure(state='normal' if available else 'disabled')
        self.stop_button.configure(state='disabled' if self.closing else 'normal')

    def attach(self, service):
        self.service = service
        self.address.set(service.origin)  # The credential is copied only on explicit request.
        self.refresh()

    def open(self):
        if self.service and not webbrowser.open(self.service.url):
            messagebox.showinfo(self.word('title'), self.word('browser'), parent=self.root)

    def copy(self):
        if self.service:
            self.root.clipboard_clear()
            self.root.clipboard_append(self.service.url)

    def activate(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self.open()

    def stop(self):
        if self.closing:
            return
        if not self.service:
            self.root.destroy()
            return
        if not self.service.app.request_stop():
            if not messagebox.askyesno(self.word('title'), self.word('confirm'), parent=self.root):
                return
            self.service.app.request_stop(confirm=True)
        self.closing = True
        self.refresh()

    def tick(self):
        if self.service.done.is_set():
            self.root.destroy()
            return
        if self.service.app.activate_event.is_set():
            self.service.app.activate_event.clear()
            if not self.service.app.stop_event.is_set():
                self.activate()
        self.closing = self.service.app.stop_event.is_set()
        self.refresh()
        self.root.after(100, self.tick)

    def run(self):
        self.tick()
        self.root.mainloop()

    def error(self, error):
        messagebox.showerror('Robot Data Viewer', str(error), parent=self.root)

    def close(self):
        try:
            self.root.destroy()
        except tk.TclError:
            pass
