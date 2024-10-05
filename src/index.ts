import joplin from 'api';
import {execSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {DateTime} from 'luxon';
import {SettingItemType} from 'api/types';

async function notifyUser(message) {
    const enableNotifications = await joplin.settings.value('enableNotifications');
    if (enableNotifications) {
        await joplin.views.dialogs.showMessageBox(message);
    } else {
        console.log(message);
    }
}

const registerSettings = async () => {
    const sectionName = 'gitSync';
    await joplin.settings.registerSection(sectionName, {
        label: 'Git Sync Settings',
        iconName: 'fas fa-sync-alt',
        description: 'Configure the Git Sync plugin settings.'
    });

    await joplin.settings.registerSettings({
        gitRepoUrl: {
            value: '',
            type: SettingItemType.String,
            section: sectionName,
            public: true,
            label: 'Git Repository URL',
            description: 'Enter the Git repository SSH remote URL like git@github.com:user/repo.git'
        },
        gitExecutablePath: {
            value: '',
            type: SettingItemType.String,
            section: sectionName,
            public: true,
            label: 'Git Executable Path',
            description: 'Path to the Git executable on your system.'
        },
        enableNotifications: {
            value: true,
            type: SettingItemType.Bool,
            section: sectionName,
            public: true,
            label: 'Enable Notifications',
            description: 'Enable or disable notifications for export and commit events.'
        },
        syncInterval: {
            value: 5,
            type: SettingItemType.Int,
            section: sectionName,
            public: true,
            label: 'Check Sync Interval (in minutes)',
            description: 'Interval in minutes to check for sync and trigger export.'
        },
        branchName: {
            value: '',
            type: SettingItemType.String,
            section: sectionName,
            public: true,
            label: 'Branch Name',
            description: 'Specify the branch to push to.'
        },
        localPathDir: {
            value: '',
            type: SettingItemType.String,
            section: sectionName,
            public: true,
            label: 'Local Path Directory to Export Notes to',
            description: 'Specify the local path directory to export notes to.'
        }
    });
};

async function cleanDirectory(directory) {
    try {
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory);
        }
        fs.readdirSync(directory).forEach(file => {
            const filePath = path.join(directory, file);
            if (file !== '.git' && file !== '.gitignore') {
                if (fs.lstatSync(filePath).isDirectory()) {
                    fs.rmdirSync(filePath, {recursive: true});
                } else {
                    fs.unlinkSync(filePath);
                }
            }
        });
    } catch (error) {
        console.error('Error clearing the export directory:', error);
        await notifyUser(`Error clearing the export directory: ${error.message}`);
    }
}

async function getAllNotes() {
    let page = 1;
    let allNotes = [];
    let hasMore = true;

    while (hasMore) {
        const response = await joplin.data.get(['notes'], {
            fields: ['id', 'title', 'body', 'parent_id', 'updated_time'],
            page: page
        });

        allNotes = allNotes.concat(response.items);
        hasMore = response.has_more;
        page += 1;
    }

    return allNotes;
}

async function exportMarkdownToDirectory(destinationDir) {
    try {
        const notebooks = await joplin.data.get(['folders'], {
            fields: ['id', 'title', 'parent_id']
        });

        const notes = await getAllNotes();

        async function createFolderStructure(parentId, currentDir) {
            const children = notebooks.items.filter(folder => folder.parent_id === parentId);

            for (const folder of children) {
                const folderPath = path.join(currentDir, folder.title);
                if (!fs.existsSync(folderPath)) {
                    fs.mkdirSync(folderPath, {recursive: true});
                }

                const notesInFolder = notes.filter(note => note.parent_id === folder.id);

                for (const note of notesInFolder) {
                    const noteFilePath = path.join(folderPath, `${sanitizeFilename(note.title)}.md`);
                    console.log(noteFilePath);
                    fs.writeFileSync(noteFilePath, note.body);
                }

                await createFolderStructure(folder.id, folderPath);
            }
        }

        await createFolderStructure('', destinationDir);
    } catch (error) {
        console.error('Error exporting notes:', error);
        await notifyUser(`Error exporting notes: ${error.message}`);
    }
}

function sanitizeFilename(filename) {
    filename = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    filename = filename.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');
    filename = filename.replace(/[^a-zA-Z0-9_\-]/g, ' ');
    filename = filename.replace(/ +/g, ' ')
    filename = filename.replace(/^ /, '');
    filename = filename.replace(/ $/, '');
    return filename;
}

async function createGitFolderIfNotExists(directory, gitPath) {
    const gitCommand = `"${gitPath}"`;
    const branchName = await joplin.settings.value('branchName');
    const gitRepoUrl = await joplin.settings.value('gitRepoUrl');

    try {
        if (fs.existsSync(path.join(directory, '.git'))) {
            return;
        }

        console.log('Git directory not found.');

        if (!gitRepoUrl) {
            execSync(`${gitCommand} init`, {cwd: directory});
            console.log('Git directory created.');
        } else {
            execSync(`${gitCommand} clone ${gitRepoUrl} ${directory}`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            execSync(`${gitCommand} checkout -b ${branchName}`);
            execSync(`${gitCommand} pull origin ${branchName}`);
            console.log('Git clone successful.');
        }
    } catch (error) {
        console.error('Error creating Git directory:', error);
    }
}

async function commitChanges(directory, gitPath) {
    const date = DateTime.now().toFormat("yyyy-MM-dd_HH-mm-ss");
    const gitCommand = `"${gitPath}"`;
    const branchName = await joplin.settings.value('branchName');

    try {
        execSync(`${gitCommand} checkout ${branchName} || ${gitCommand} checkout -b ${branchName}`, {cwd: directory});
        console.log('Git checkout successful.');
        execSync(`${gitCommand} add .`, {cwd: directory});
        console.log('Git add successful.');
        const statusOutput = execSync(`${gitCommand} status`, {cwd: directory}).toString();
        console.log('Git status output:', statusOutput);

        if (statusOutput.includes('nothing to commit')) {
            console.log('Nothing to commit.');
        } else {
            execSync(`${gitCommand} commit -m "Exported on ${date}"`, {cwd: directory});
            console.log('Git commit successful.');
        }
    } catch (error) {
        console.error('Error during Git commit:', error.message);
        console.error('Full error output:', error.stderr?.toString() || error.toString());
        throw error;
    }
}

async function pushChanges(directory, gitPath) {
    const gitRepoUrl = await joplin.settings.value('gitRepoUrl');
    const branchName = await joplin.settings.value('branchName');
    const gitCommand = `"${gitPath}"`;

    try {
        const remoteOutput = execSync(`${gitCommand} remote -v`, {cwd: directory}).toString();

        if (!remoteOutput.includes('origin')) {
            execSync(`${gitCommand} remote add origin ${gitRepoUrl}`, {cwd: directory});
            console.log('Git remote add successful.');
        }

        execSync(`${gitCommand} push origin ${branchName} --set-upstream --force`, {cwd: directory});
        console.log('Git push successful.');
    } catch (error) {
        console.error('Error during Git push:', error);
        throw error;
    }
}

async function exportAndSync() {
    const gitExecutablePath = await joplin.settings.value('gitExecutablePath');
    const localPathDir = await joplin.settings.value('localPathDir');
    const branchName = await joplin.settings.value('branchName');

    if (!branchName || !localPathDir) {
        console.log('Please configure the plugin settings.');
        await notifyUser('Please configure the plugin settings.');
        return;
    }

    await cleanDirectory(localPathDir);
    await createGitFolderIfNotExists(localPathDir, gitExecutablePath);
    await exportMarkdownToDirectory(localPathDir);
    await commitChanges(localPathDir, gitExecutablePath);
    await pushChanges(localPathDir, gitExecutablePath);
}

joplin.plugins.register({
    onStart: main
});

async function main() {
    await registerSettings();
    const syncInterval = await joplin.settings.value('syncInterval');
    const intervalInMs = syncInterval * 60 * 1000;
    setInterval(exportAndSync, intervalInMs);
}
