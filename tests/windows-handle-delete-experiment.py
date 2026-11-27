"""Isolated Windows handle-deletion experiment; never operates on user files."""
import ctypes as c
from ctypes import wintypes as w
import json
from pathlib import Path
import subprocess
import sys
import tempfile

if sys.platform != 'win32':
    print('SKIP: this experiment requires Windows')
    sys.exit(0)

k = c.WinDLL('kernel32', use_last_error=True)
k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
k.CreateFileW.restype = w.HANDLE
k.CloseHandle.argtypes = [w.HANDLE]
k.CloseHandle.restype = w.BOOL
k.ReadFile.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, c.POINTER(w.DWORD), w.LPVOID]
k.ReadFile.restype = w.BOOL
k.SetFileInformationByHandle.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
k.SetFileInformationByHandle.restype = w.BOOL
k.MoveFileExW.argtypes = [w.LPCWSTR, w.LPCWSTR, w.DWORD]
k.MoveFileExW.restype = w.BOOL

class FileInfo(c.Structure):
    _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME), ('accessed', w.FILETIME),
                ('modified', w.FILETIME), ('volume', w.DWORD), ('size_high', w.DWORD),
                ('size_low', w.DWORD), ('links', w.DWORD), ('index_high', w.DWORD), ('index_low', w.DWORD)]

class Disposition(c.Structure):
    _fields_ = [('delete_file', w.BOOL)]

k.GetFileInformationByHandle.argtypes = [w.HANDLE, c.POINTER(FileInfo)]
k.GetFileInformationByHandle.restype = w.BOOL
INVALID = c.c_void_p(-1).value
READ, WRITE, DELETE, SHARE_ALL = 0x80000000, 0x40000000, 0x10000, 7


def open_handle(path, access, share):
    c.set_last_error(0)
    handle = k.CreateFileW(str(path), access, share, None, 3, 0x80, None)
    return handle, c.get_last_error()


def close_handle(handle):
    if not k.CloseHandle(handle):
        raise OSError(c.get_last_error(), 'CloseHandle failed')


def identity(handle):
    info = FileInfo()
    if not k.GetFileInformationByHandle(handle, c.byref(info)):
        raise OSError(c.get_last_error(), 'GetFileInformationByHandle failed')
    return (info.volume, info.index_high, info.index_low, info.size_high, info.size_low)


def child_mode(mode, target, replacement):
    directory = target.parent.resolve()
    if (directory.parent != Path(tempfile.gettempdir()).resolve()
            or not directory.name.startswith('dsh-winhandle-proof-')
            or target.name != 'source.md' or replacement != directory / 'replacement.tmp'
            or mode not in ('hold', 'read', 'write', 'replace')):
        raise ValueError('Child mode only accepts the isolated experiment paths')
    if mode == 'hold':
        handle, error = open_handle(target, WRITE, SHARE_ALL)
        print(json.dumps({'opened': handle != INVALID, 'winerror': error}), flush=True)
        if handle == INVALID:
            sys.exit(1)
        try:
            sys.stdin.readline()
        finally:
            close_handle(handle)
        return
    if mode == 'replace':
        success = bool(k.MoveFileExW(str(replacement), str(target), 1))
        error = 0 if success else c.get_last_error()
    else:
        handle, error = open_handle(target, READ if mode == 'read' else WRITE, SHARE_ALL)
        success = handle != INVALID
        if success:
            close_handle(handle)
    print(json.dumps({'op': mode, 'success': success, 'winerror': error}), flush=True)


def run_experiment():
    with tempfile.TemporaryDirectory(prefix='dsh-winhandle-proof-') as directory:
        target = Path(directory) / 'source.md'
        replacement = Path(directory) / 'replacement.tmp'
        target.write_bytes(b'original')
        replacement.write_bytes(b'replacement')
        script = str(Path(__file__).resolve())
        child = subprocess.Popen([sys.executable, script, '--child', 'hold', str(target), str(replacement)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            started = json.loads(child.stdout.readline())
            assert started['opened'], started
            handle, error = open_handle(target, READ | DELETE, 0)
            assert handle == INVALID and error == 32, (handle, error)
            print(json.dumps({'case': 'external_existing_write_handle', 'exclusive_open_rejected': True, 'winerror': error}))
        finally:
            child.stdin.write('close\n')
            child.stdin.flush()
            _, stderr = child.communicate(timeout=10)
            if child.returncode != 0:
                raise RuntimeError(stderr)
        handle, error = open_handle(target, READ | DELETE, 0)
        assert handle != INVALID, error
        try:
            before = identity(handle)
            buffer = c.create_string_buffer(64)
            count = w.DWORD()
            assert k.ReadFile(handle, buffer, len(buffer), c.byref(count), None), c.get_last_error()
            assert buffer.raw[:count.value] == b'original'
            assert identity(handle) == before
            print(json.dumps({'case': 'same_handle_content_and_identity', 'verified': True, 'bytes': count.value}))
            for stage in ('exclusive', 'delete_pending'):
                if stage == 'delete_pending':
                    disposition = Disposition(True)
                    assert k.SetFileInformationByHandle(handle, 4, c.byref(disposition), c.sizeof(disposition)), c.get_last_error()
                    print(json.dumps({'case': 'same_handle_mark_delete', 'success': True}))
                for mode in ('read', 'write', 'replace'):
                    result = subprocess.run([sys.executable, script, '--child', mode, str(target), str(replacement)],
                                            capture_output=True, text=True, timeout=10, check=True)
                    observation = json.loads(result.stdout)
                    assert not observation['success'], observation
                    print(json.dumps({'case': stage, **observation}))
        finally:
            close_handle(handle)
        assert not target.exists()
        target.write_bytes(b'new file')
        assert target.read_bytes() == b'new file'
        print(json.dumps({'case': 'after_close', 'original_absent': True, 'new_file_created': True}))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        child_mode(sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4]))
    else:
        run_experiment()
