'use strict';
const path = require('path');
const os = require('os');
const electron = require('electron');
const {app} = require('electron');
const ipc = require('electron').ipcMain;
const {dialog} = require('electron');
const electronLocalshortcut = require('electron-localshortcut');
const Configstore = require('electron-config');
const isDev = require('electron-is-dev');
const appMenu = require('./menu');
const {appUpdater} = require('./autoupdater');

// Adds debug features like hotkeys for triggering dev tools and reload
require('electron-debug')();

const conf = new Configstore();

function userOS() {
	if (os.platform() === 'darwin') {
		return 'Mac';
	}
	if (os.platform() === 'linux') {
		return 'Linux';
	}
	if (os.platform() === 'win32' || os.platform() === 'win64') {
		if (parseFloat(os.release()) < 6.2) {
			return 'Windows 7';
		} else {
			return 'Windows 10';
		}
	}
}

// Setting userAgent so that server-side code can identify the desktop app
const isUserAgent = 'ZulipElectron/' + app.getVersion() + ' ' + userOS();

// Prevent window being garbage collected
let mainWindow;

// Load this url in main window
const mainURL = 'file://' + path.join(__dirname, '../renderer', 'main.html');

function checkConnectivity() {
	return dialog.showMessageBox({
		title: 'Internet connection problem',
		message: 'No internet available! Try again?',
		type: 'warning',
		buttons: ['Try again', 'Close'],
		defaultId: 0
	}, index => {
		if (index === 0) {
			mainWindow.webContents.reload();
			mainWindow.webContents.send('destroytray');
		}
		if (index === 1) {
			app.quit();
		}
	});
}
const connectivityERR = [
	'ERR_INTERNET_DISCONNECTED',
	'ERR_PROXY_CONNECTION_FAILED',
	'ERR_CONNECTION_RESET',
	'ERR_NOT_CONNECTED',
	'ERR_NAME_NOT_RESOLVED'
];

// TODO
function checkConnection() {
	// eslint-disable-next-line no-unused-vars
	mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
		const hasConnectivityErr = (connectivityERR.indexOf(errorDescription) >= 0);
		if (hasConnectivityErr) {
			console.error('error', errorDescription);
			checkConnectivity();
		}
	});
}

const isAlreadyRunning = app.makeSingleInstance(() => {
	if (mainWindow) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}

		mainWindow.show();
	}
});

if (isAlreadyRunning) {
	app.quit();
}

function isWindowsOrmacOS() {
	return process.platform === 'darwin' || process.platform === 'win32';
}

const APP_ICON = path.join(__dirname, '../resources', 'Icon');

const iconPath = () => {
	return APP_ICON + (process.platform === 'win32' ? '.ico' : '.png');
};

function onClosed() {
	// Dereference the window
	// For multiple windows, store them in an array
	mainWindow = null;
}

function updateDockBadge(title) {
	if (title.indexOf('Zulip') === -1) {
		return;
	}

	let messageCount = (/\(([0-9]+)\)/).exec(title);
	messageCount = messageCount ? Number(messageCount[1]) : 0;

	if (process.platform === 'darwin') {
		app.setBadgeCount(messageCount);
	}
	mainWindow.webContents.send('tray', messageCount);
}

function createMainWindow() {
	const win = new electron.BrowserWindow({
		// This settings needs to be saved in config
		title: 'Zulip',
		width: conf.get('width') || 1000,
		height: conf.get('height') || 600,
		icon: iconPath(),
		minWidth: 600,
		minHeight: 400,
		titleBarStyle: 'hidden-inset',
		webPreferences: {
			plugins: true,
			allowDisplayingInsecureContent: true,
			nodeIntegration: true
		},
		show: false
	});

	win.once('ready-to-show', () => {
		win.show();
	});

	win.loadURL(mainURL, {
		userAgent: isUserAgent + ' ' + win.webContents.getUserAgent()
	});

	win.on('closed', onClosed);
	win.setTitle('Zulip');

	// Let's save browser window position
	if (conf.get('x') || conf.get('y')) {
		win.setPosition(conf.get('x'), conf.get('y'));
	}

	if (conf.get('maximize')) {
		win.maximize();
	}

	// Handle sizing events so we can persist them.
	win.on('maximize', () => {
		conf.set('maximize', true);
	});

	win.on('unmaximize', () => {
		conf.set('maximize', false);
	});

	win.on('resize', function () {
		const size = this.getSize();
		conf.set({
			width: size[0],
			height: size[1]
		});
	});

	// On osx it's 'moved'
	win.on('move', function () {
		const pos = this.getPosition();
		conf.set({
			x: pos[0],
			y: pos[1]
		});
	});

	// Stop page to update it's title
	win.on('page-title-updated', (e, title) => {
		e.preventDefault();
		updateDockBadge(title);
	});

	//  To destroy tray icon when navigate to a new URL
	win.webContents.on('will-navigate', e => {
		if (e) {
			win.webContents.send('destroytray');
		}
	});

	return win;
}

// eslint-disable-next-line max-params
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
	event.preventDefault();
	callback(true);
});

app.on('window-all-closed', () => {
	// Unregister all the shortcuts so that they don't interfare with other apps
	electronLocalshortcut.unregisterAll(mainWindow);
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	if (!mainWindow) {
		mainWindow = createMainWindow();
	}
});

app.on('ready', () => {
	electron.Menu.setApplicationMenu(appMenu);
	mainWindow = createMainWindow();
	// Not using for now // tray.create();

	const page = mainWindow.webContents;

	// TODO - use global shortcut instead
	electronLocalshortcut.register(mainWindow, 'CommandOrControl+R', () => {
		page.send('reload');
		// page.send('destroytray');
	});

	electronLocalshortcut.register(mainWindow, 'CommandOrControl+[', () => {
		page.send('back');
	});

	electronLocalshortcut.register(mainWindow, 'CommandOrControl+]', () => {
		page.send('forward');
	});

	page.on('dom-ready', () => {
		mainWindow.show();
	});

	page.once('did-frame-finish-load', () => {
		const checkOS = isWindowsOrmacOS();
		if (checkOS && !isDev) {
			// Initate auto-updates on MacOS and Windows
			appUpdater();
		}
	});
	checkConnection();

	ipc.on('reload-main', () => {
		page.reload();
	});
});

app.on('will-quit', () => {
	// Unregister all the shortcuts so that they don't interfare with other apps
	electronLocalshortcut.unregisterAll(mainWindow);
});
