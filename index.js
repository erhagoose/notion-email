const { Client } = require('@notionhq/client');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');

dotenv.config();
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER, // generated ethereal user
    pass: process.env.EMAIL_PASS, // generated ethereal password
  },
});
const notion = new Client({ auth: process.env.NOTION_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

const refreshPeriod = process.env.REFRESH_PERIOD_MS || 5000;

/**
 * Local map to store task pageId to its last status.
 * { [pageId: string]: string }
 */
const taskPageIdToStatusMap = {};

/**
 * Initialize local data store.
 * Then poll for changes every 5 seconds (5000 milliseconds).
 */
setInitialTaskPageIdToStatusMap().then(() => {
  setInterval(findAndSendEmailsForUpdatedTasks, refreshPeriod);
});

/**
 * Get and set the initial data store with tasks currently in the database.
 */
async function setInitialTaskPageIdToStatusMap() {
  const currentTasks = await getTasksFromNotionDatabase();
  for (const { pageId, status } of currentTasks) {
    taskPageIdToStatusMap[pageId] = status;
  }
}

async function getSummaryOfPage(pageId) {
  const { results } = await notion.blocks.children.list({ block_id: pageId });
  const summary = results.map((block) => {
    const { type } = block;
    if (block[type].text) {
      return block[type].text.map((t) => t.text.content).join('\n');
    }
    return '';
  }).join('\n');
  return summary;
}

async function findAndSendEmailsForUpdatedTasks() {
  // Get the tasks currently in the database.
  // console.log("\nFetching tasks from Notion DB...")
  const currentTasks = await getTasksFromNotionDatabase();

  // Return any tasks that have had their status updated.
  const updatedTasks = findUpdatedTasks(currentTasks);
  if (updatedTasks.length > 0) console.log(`Found ${updatedTasks.length} updated tasks.`);

  // For each updated task, update taskPageIdToStatusMap and send an email notification.
  for (const task of updatedTasks) {
    taskPageIdToStatusMap[task.pageId] = task.status;
    await sendUpdateEmail(task);
  }
}

/**
 * Gets tasks from the database.
 *
 * @returns {Promise<Array<{ pageId: string, status: string, title: string }>>}
 */
async function getTasksFromNotionDatabase() {
  const pages = [];
  let cursor = undefined;

  for (;;) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    pages.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }
  // console.log(`${pages.length} pages successfully fetched.`)
  return pages.map(page => {
    const statusProperty = page.properties['Status'];
    const status = statusProperty ? (statusProperty.select ? statusProperty.select.name : 'No Status') : 'No Status';
    const title = page.properties['Name'].title
      .map(({ plain_text }) => plain_text)
      .join('');
    return {
      pageId: page.id,
      status,
      title,
    };
  });
}

/**
 * Compares task to most recent version of task stored in taskPageIdToStatusMap.
 * Returns any tasks that have a different status than their last version.
 *
 * @param {Array<{ pageId: string, status: string, title: string }>} currentTasks
 * @returns {Array<{ pageId: string, status: string, title: string }>}
 */
function findUpdatedTasks(currentTasks) {
  return currentTasks.filter(currentTask => {
    const previousStatus = getPreviousTaskStatus(currentTask);
    return currentTask.status !== previousStatus;
  });
}

/**
 * Sends task update notification.
 *
 * @param {{ status: string, title: string }} task
 */
async function sendUpdateEmail({ title, status, pageId }) {
  const summary = await getSummaryOfPage(pageId);
  const message = `Page contents brief summary 😜: \n ${summary}`;

  try {
    // send mail with defined transport object
    let info = await transporter.sendMail({
      from: process.env.EMAIL_FROM_FIELD, // sender address
      to: process.env.EMAIL_TO_FIELD, // list of receivers
      subject: `Status of "${title}" Notion Page has been updated to "${status}"`, // Subject line
      text: message, // plain text body
      // html: "<b>Hello world?</b>", // html body
    });
    console.log('✅ Message sent: %s', info.messageId);
  } catch (error) {
    console.error(error);
  }
}

/**
 * Finds or creates task in local data store and returns its status.
 * @param {{ pageId: string; status: string }} task
 * @returns {string}
 */
function getPreviousTaskStatus({ pageId, status }) {
  // If this task hasn't been seen before, add to local pageId to status map.
  if (!taskPageIdToStatusMap[pageId]) {
    taskPageIdToStatusMap[pageId] = status;
  }
  return taskPageIdToStatusMap[pageId];
}
