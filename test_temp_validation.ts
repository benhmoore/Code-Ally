import { tmpdir, homedir } from 'os';
import path from 'path';
import { cwd } from 'process';

/**
 * Test the isSafeTempDirectory logic
 */
function isSafeTempDirectory(tempDir: string): boolean {
  try {
    const absTempDir = path.resolve(tempDir);
    const systemTmpDir = path.resolve(tmpdir());
    const homeDir = path.resolve(homedir());
    const workingDir = path.resolve(cwd());

    // Allow if within system temp directory
    if (absTempDir.startsWith(systemTmpDir)) {
      return true;
    }

    // Allow if under /tmp or /var/tmp on Unix systems
    if (process.platform !== 'win32') {
      if (absTempDir.startsWith('/tmp') || absTempDir.startsWith('/var/tmp')) {
        return true;
      }
    }

    // Allow if under user's home directory
    if (absTempDir.startsWith(homeDir)) {
      return true;
    }

    // Allow if under current working directory
    if (absTempDir.startsWith(workingDir)) {
      return true;
    }

    // Not in a safe location
    return false;
  } catch (error) {
    console.error(`Error validating temp directory: ${error}`);
    return false;
  }
}

// Test cases
console.log('System tmpdir:', tmpdir());
console.log('Home dir:', homedir());
console.log('CWD:', cwd());
console.log('');

// Test default temp directory
console.log('Test /tmp:', isSafeTempDirectory('/tmp'));
console.log('Test /tmp/nested:', isSafeTempDirectory('/tmp/nested'));

// Test var/tmp
console.log('Test /var/tmp:', isSafeTempDirectory('/var/tmp'));

// Test home directory
console.log('Test home:', isSafeTempDirectory(homedir()));
console.log('Test home/.cache:', isSafeTempDirectory(path.join(homedir(), '.cache')));

// Test CWD
console.log('Test CWD:', isSafeTempDirectory(cwd()));
console.log('Test CWD/temp:', isSafeTempDirectory(path.join(cwd(), 'temp')));

// Test unsafe path
console.log('Test /etc:', isSafeTempDirectory('/etc'));
console.log('Test /root:', isSafeTempDirectory('/root'));

// Edge case: symlink resolution
console.log('Test with symlink (.): isSafeTempDirectory("."):', isSafeTempDirectory('.'));
console.log('Test with symlink (~): would fail due to ~ handling');

// Edge case: trailing slashes
const testPath = tmpdir() + '/';
console.log('Test with trailing slash:', isSafeTempDirectory(testPath));

// Edge case: double slashes
const testPath2 = tmpdir() + '//nested';
console.log('Test with double slashes:', isSafeTempDirectory(testPath2));

// Test if tmpdir itself is safe
console.log('Test tmpdir():', isSafeTempDirectory(tmpdir()));
