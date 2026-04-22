/**
 * System Tray Management
 * Creates and manages the system tray icon and menu
 */
import { Tray, Menu, BrowserWindow, app, nativeImage } from 'electron';
import { join } from 'path';
import { showAutoLoginHintDialog } from './auto-login-hint';

let tray: Tray | null = null;

export function buildTrayMenuTemplate(mainWindow: BrowserWindow): Electron.MenuItemConstructorOptions[] {
  const showWindow = () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  };
  return [
    { label: 'Show MyClaw', click: showWindow },
    { type: 'separator' },
    { label: 'Gateway Status', enabled: false },
    { label: '  Running', type: 'checkbox', checked: true, enabled: false },
    { type: 'separator' },
    {
      label: 'Quick Actions',
      submenu: [
        {
          label: 'Open Chat',
          click: () => {
            if (mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.webContents.send('navigate', '/');
          },
        },
        {
          label: 'Open Settings',
          click: () => {
            if (mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.webContents.send('navigate', '/settings');
          },
        },
      ],
    },
    { type: 'separator' },
    ...(process.platform === 'win32'
      ? [
          {
            label: '配置开机自动启动...',
            click: () => {
              void showAutoLoginHintDialog(mainWindow.isDestroyed() ? undefined : mainWindow);
            },
          } as Electron.MenuItemConstructorOptions,
          { type: 'separator' as const },
        ]
      : []),
    {
      label: 'Check for Updates...',
      click: () => {
        if (mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('update:check');
      },
    },
    { type: 'separator' },
    { label: 'Quit MyClaw', click: () => { app.quit(); } },
  ];
}

export function __getE2EMenuLabels(mainWindow: BrowserWindow): string[] {
  const flatten = (items: Electron.MenuItemConstructorOptions[]): string[] =>
    items.flatMap((item) => {
      if (item.type === 'separator') return [];
      const label = typeof item.label === 'string' ? item.label : '';
      const sub = Array.isArray(item.submenu)
        ? flatten(item.submenu as Electron.MenuItemConstructorOptions[])
        : [];
      return [label, ...sub];
    });
  return flatten(buildTrayMenuTemplate(mainWindow));
}

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'icons');
  }
  return join(__dirname, '../../resources/icons');
}

/**
 * Create system tray icon and menu
 */
export function createTray(mainWindow: BrowserWindow): Tray {
  // Use platform-appropriate icon for system tray
  const iconsDir = getIconsDir();
  let iconPath: string;

  if (process.platform === 'win32') {
    // Windows: use .ico for best quality in system tray
    iconPath = join(iconsDir, 'icon.ico');
  } else if (process.platform === 'darwin') {
    // macOS: use Template.png for proper status bar icon
    // The "Template" suffix tells macOS to treat it as a template image
    iconPath = join(iconsDir, 'tray-icon-Template.png');
  } else {
    // Linux: use 32x32 PNG
    iconPath = join(iconsDir, '32x32.png');
  }

  let icon = nativeImage.createFromPath(iconPath);

  // Fallback to icon.png if platform-specific icon not found
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(join(iconsDir, 'icon.png'));
    // Still try to set as template for macOS
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }
  }

  // Note: Using "Template" suffix in filename automatically marks it as template image
  // But we can also explicitly set it for safety
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }
  
  tray = new Tray(icon);

  // Set tooltip
  tray.setToolTip('MyClaw - AI Assistant');

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate(mainWindow));
  tray.setContextMenu(contextMenu);
  
  // Click to show window (Windows/Linux)
  tray.on('click', () => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  
  // Double-click to show window (Windows)
  tray.on('double-click', () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
  
  return tray;
}

/**
 * Update tray tooltip with Gateway status
 */
export function updateTrayStatus(status: string): void {
  if (tray) {
    tray.setToolTip(`MyClaw - ${status}`);
  }
}

/**
 * Destroy tray icon
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
