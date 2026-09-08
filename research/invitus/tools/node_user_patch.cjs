// The Windows Codex sandbox can make os.userInfo() fail before tsx starts.
// Supplying a process-local numeric id keeps tsx's temp directory deterministic.
if (process.platform === 'win32' && typeof process.geteuid !== 'function') {
  process.geteuid = () => 1000;
}
