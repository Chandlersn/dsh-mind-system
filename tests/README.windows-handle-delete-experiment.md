# Windows handle deletion experiment

Run from the repository root on Windows with Python 3 and its standard library:

```powershell
py -3 tests/windows-handle-delete-experiment.py
```

The script creates and removes its own temporary directory and launches independent Python processes. It is not connected to a production cleanup path or a test runner. It takes no user-provided target path. On non-Windows platforms it prints `SKIP` and exits successfully; this is not a pass on that platform. An assertion or subprocess error returns a nonzero exit code.

The experiment checks the following matrix:

| Stage | External process action | Expected observation |
| --- | --- | --- |
| Before exclusive open | Hold an existing write handle opened with all share flags | Parent's exclusive open fails with Windows sharing violation 32 |
| Exclusive handle held | Open source for read; open for write; replace source path | Every operation fails |
| Same handle marked for deletion | Repeat external read, write and replacement | Every operation fails |
| Handle closed | Inspect source path; create a new file there | Original absent; new file created |

Between opening and marking deletion, the script reads and compares the expected bytes through the handle and compares its volume, file index and size before and after the read. It calls `SetFileInformationByHandle(FileDispositionInfo)` on that same handle. Each observation prints a JSON line including the actual Windows error code when available.

This is a constrained local experiment, not a production deletion protocol or a cross-platform guarantee. It does not establish safety for memory-mapped writes, hard links, reparse points, parent directory replacement, other filesystems, crashes, or ledger transaction semantics. It also does not prove identity relative to an earlier archive snapshot; a production design needs independently verified snapshot identity and must retain the source whenever exclusivity or verification fails.
