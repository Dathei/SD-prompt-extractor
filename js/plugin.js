const { exec } = require('child_process');
const util = require('util');
const path = require('path');

const execPromise = util.promisify(exec);

// const pythonScript = path.join(__dirname, "./prompt_extractor.py");
const pythonScript = path.join(__dirname, "dist", "prompt_extractor.exe");
const POLL_INTERVAL = 5000;

// let lastSyncTime = Date.now();
let isInitialized = false;
let isProcessing = false;
let knownItems = new Map();

eagle.onPluginCreate((plugin) => {
	setInterval(async () => {
		if (isProcessing) return;
		isProcessing = true;

		try {
			let allFiles = await eagle.item.getIdsWithModifiedAt();

			// This doesn't work:
			// let modifiedFiles = allFiles.filter(file => file.modifiedAt > lastSyncTime);

			if (!isInitialized) {
				allFiles.forEach(file => {
					knownItems.set(file.id, file.modifiedAt || 0)
				});
				isInitialized = true;
				console.log(`Plugin initialized. Tracking ${knownItems.size} items.`);
				isProcessing = false;
				return;
			}

			let modifiedIds = [];

			for (let file of allFiles) {
				let prevModified = knownItems.get(file.id);
				let currModified = file.modifiedAt || 0;

				if (prevModified === undefined || currModified > prevModified) {		// new || modified, maybe only check for new?
					modifiedIds.push(file.id);
					knownItems.set(file.id, currModified);
				}
			}

			if (modifiedIds.length > 0) {
				console.log(`Found ${modifiedIds.length} new/modified items`, modifiedIds);

				let fullItems = await eagle.item.getByIds(modifiedIds);
				let newItems = fullItems.filter(item => !item.annotation);	// Only process files with no annotation

				for (let item of newItems) {
					const itemInfoFolder = path.dirname(item.metadataFilePath);

					// const command = `python "${pythonScript}" api --file "${itemInfoFolder}" --strip_version`;
					const command = `"${pythonScript}" api --file "${itemInfoFolder}" --strip_version`;

					try {
						console.log(`Running Python script for item ${item.id}: ${command}`);

						const { stdout, stderr } = await execPromise(command);
						if (stdout) {
							console.log(`Successfully extracted for ${item.id}: ${stdout}`);
							try {
								let data = JSON.parse(stdout);
								console.log('Parsed Data:', typeof data);
								let annotation = data.annotation || "";
								let tags = data.tags || [];

								if (!item.annotation && annotation !== "") item.annotation = annotation;
								if (tags.length > 0) {
									let currentTags = item.tags || [];
									// Prevents duplicates and deletion of custom tags
									item.tags = [...new Set([...currentTags, ...tags])];
								}

								console.log(item.tags, tags)
								await item.save();

								console.log(`annotation: ${annotation}, tags: ${tags}`);
							} catch (error) {
								console.error(`Python script failed for {item.id}:`, error)
							}
						}
					} catch (error) {
						console.error(`Python script failed for item ${item.id}:`, error);
					}
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			} else {
				console.log("No files modified")
			}
		} catch (error) {
			console.error("Polling error: ", error)
		} finally {
			isProcessing = false;
		}
	}, POLL_INTERVAL);
});