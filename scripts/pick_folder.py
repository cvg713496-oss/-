import sys
import os
import tkinter as tk
from tkinter import filedialog

def pick_folder(initial_dir=""):
    try:
        root = tk.Tk()
        root.withdraw()
        # Bring dialog to front on top of browser
        root.attributes('-topmost', True)
        root.focus_force()

        if initial_dir:
            if len(initial_dir) == 2 and initial_dir[1] == ':':
                initial_dir = initial_dir + '\\'
            if not os.path.exists(initial_dir):
                initial_dir = ""

        folder = filedialog.askdirectory(
            parent=root,
            title="ជ្រើសរើស Folder ឬ Drive សម្រាប់រក្សាទុកវីដេអូ (Output Folder)",
            initialdir=initial_dir if initial_dir else os.path.abspath("outputs")
        )
        root.destroy()
        return folder
    except Exception as e:
        sys.stderr.write(str(e))
        return ""

if __name__ == "__main__":
    initial = sys.argv[1] if len(sys.argv) > 1 else ""
    res = pick_folder(initial)
    if res:
        full_path = os.path.abspath(res)
        sys.stdout.buffer.write(full_path.encode('utf-8'))
        sys.stdout.buffer.flush()
