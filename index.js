const rp = require("request-promise");
const cheerio = require("cheerio");
const imageDownloader = require("image-downloader");
const fs = require("fs");
const ffmetadata = require("ffmetadata");
const stringSimilarity = require("string-similarity");

const filePath = process.argv[2] || ".";
const prompt = require("prompt-sync")({ sigint: true });

const jsonConfig = fs.readFileSync("config.json");
const result = JSON.parse(jsonConfig);

if (!jsonConfig || !result || !result.sites) {
  throw new Error("Error: invalid config");
}

const { sites } = result;

const concatAllElVals = (els, item, $) => {
  const { bracketSubsequentMatchingEls, attribute, name } = item;

  const vals = [];
  try {
    els.each(function (i, e) {
      if (attribute) {
        vals.push(e.attribs[attribute]);
      } else {
        vals.push($(e).text());
      }
    });
  } catch (e) {
    throw new Error(`ERROR on item: ${name}, ${e}`);
  }

  if (bracketSubsequentMatchingEls) {
    // used for track name
    return `${vals[0]} (${vals.slice(1).join(" ")})`;
  }

  return vals.join(", ");
};

const getFirstElVal = (els, item, $) => {
  let val;
  try {
    if (item.attribute) {
      val = els[0].attribs[item.attribute];
    } else {
      // if (item.name === "date") console.log(els[0].text());
      val = els.text ? els.text() : els[0].text();
    }
  } catch (e) {
    throw new Error(`ERROR on item: ${item.name}, ${e}`);
  }
  return val;
};

const extractMetadataFromSongPageHtml = (html, siteConfig) => {
  const { trackPageSelectors } = siteConfig;
  const $ = cheerio.load(html);

  return trackPageSelectors.reduce((acc, item) => {
    const els = $(item.selector);
    let val;
    if (item.ignoreSubsequentMatchingEls) {
      val = getFirstElVal(els, item, $);
    } else {
      val = concatAllElVals(els, item, $);
    }

    return {
      ...acc,
      [item.name]: val,
    };
  }, {});
};

const forReview = [];

const getUrlOfFirstResult = (
  html,
  siteConfig,
  searchQuery,
  fileName,
  siteIndex
) => {
  const $ = cheerio.load(html);
  const { resultPageSelectors } = siteConfig;
  const values = resultPageSelectors.reduce(
    (acc, { name, selector, attribute = null }) => {
      const vals = [];
      $(selector).each((i, e) => {
        // console.log(e);
        if (attribute) {
          vals.push(e.attribs[attribute]);
        } else {
          vals.push($(e).text());
        }
      });

      return { ...acc, [name]: vals };
    },
    {}
  );

  if (!values || !values.title || !values.title.length) {
    return false;
  }

  const { artist, title, subtitle, href } = values;

  const matchStrings = title.reduce((acc, current, index) => {
    let matchString = `${artist[index] || ""} - ${title[index] || ""}`;
    if (subtitle[index]) {
      matchString = `${matchString} (${subtitle[index]})`;
    }

    return [...acc, matchString];
  }, []);

  let closest = {
    similarity: -1,
  };

  const results = matchStrings.map((humanMatchString, index) => {
    const machineMatchString = humanMatchString.split(" ").join("+");
    const similarity = stringSimilarity.compareTwoStrings(
      machineMatchString,
      searchQuery
    );

    const returnObj = { name: humanMatchString, similarity, href: href[index] };

    if (similarity > closest.similarity) {
      closest = returnObj;
    }

    return returnObj;
  });

  if (closest.similarity < 0.7) {
    forReview.push({ fileName, results, siteIndex });
    return false;
  }

  console.log(
    `Closest match is ${closest.name} with a  similarity of ${closest.similarity}`
  );

  return closest.href;
};

const extractSongPageUrlFromResultsPage = (
  html,
  siteConfig,
  searchQuery,
  fileName,
  siteIndex
) => {
  // get resulkts
  // loop through getting the matching string and checking how close
  const hrefOfFirstResult = getUrlOfFirstResult(
    html,
    siteConfig,
    searchQuery,
    fileName,
    siteIndex
  );
  if (!hrefOfFirstResult) return;
  const trackPageUrl = `${siteConfig.baseUrl}${hrefOfFirstResult}`;
  return trackPageUrl;
};

const getPage = async (url) => {
  const page = await rp(url).catch(function (err) {
    console.error(
      `Could not retrieve the page at ${url}, original error: ${err}`
    );
  });

  return page;
};

// getPage(initialUrl, processResultsPageHtml);

const convertFileNameToSearchQuery = (filename) => {
  const convertToPlus = ["_", " ", ">", "<", "|"];
  const remove = ["myfreemp3s", "my-free-mp3s"];
  const removedExtension = filename.split(".")[0].toLowerCase();

  const removed = remove.reduce(
    (prev, current) => prev.split(current).join(""),
    removedExtension
  );

  const replaced = convertToPlus.reduce(
    (prev, current) => prev.split(current).join("+"),
    removed
  );

  const withVersionString =
    replaced.indexOf("mix") >= 0 ? replaced : replaced + "+original+mix";

  return withVersionString;
};

const getFiles = (path, callback) => {
  fs.readdir(path, function (err, fileNames) {
    if (err) {
      console.error("Could not list the directory.", err);
      process.exit(1);
    }
    callback(fileNames);
  });
};

const filterFileNames = (fileNames) =>
  fileNames.filter((file) => {
    const split = file.split(".");
    const extension = split[split.length - 1].toLowerCase();
    return extension === "mp3" || extension === "wav"; // ToDO add others
  });

const deleteFile = (pathToFile) => {
  fs.unlink(pathToFile, (err) => {
    if (err) {
      throw err;
    }
  });
};

const writeMetadataToSong = (metadata, imagePath, fileName, path) =>
  new Promise((resolve, reject) => {
    const options = { attachments: [imagePath] };
    ffmetadata.write(`${path}/${fileName}`, metadata, options, function (err) {
      if (err) console.error("Error writing metadata", err);
      else {
        console.log("✅ Data written to " + fileName);
        deleteFile(imagePath);
      }
      resolve();
    });
  });

let currentImageIndex = 0;
const downloadImage = async (url) => {
  currentImageIndex++;
  const options = {
    url,
    dest: `./images/${currentImageIndex}.jpg`,
  };
  const result = await imageDownloader.image(options);
  return result.filename;
};

const getDataFromSongPageAndWrite = async (songPageUrl, site, sf) => {
  const songPageHtml = await getPage(songPageUrl);
  const songMetadata = extractMetadataFromSongPageHtml(songPageHtml, site);

  const { artwork, ...otherMetadata } = songMetadata;

  const imagePath = await downloadImage(artwork);

  await writeMetadataToSong(otherMetadata, imagePath, sf, filePath);
};

const processFile = async (sf, site, siteIndex) => {
  const searchQuery = convertFileNameToSearchQuery(sf);
  const songSearchUrl = `${site.baseUrl}${site.searchPageSlug}${searchQuery}`;
  console.log(`Searching ${site.name} URL: ${songSearchUrl}`);
  const resultsPage = await getPage(songSearchUrl);
  const songPageUrl = extractSongPageUrlFromResultsPage(
    resultsPage,
    site,
    searchQuery,
    sf,
    siteIndex
  );
  if (!songPageUrl) {
    return;
  }

  await getDataFromSongPageAndWrite(songPageUrl, site, sf);

  console.log(`Found song page: ${songPageUrl}`);
};

const searchForMetadata = async (file) => {
  await Promise.all(
    sites.map(async (site, index) => {
      await processFile(file, site, index);
    })
  );
};

const processAllFiles = async (files) => {
  const songFiles = filterFileNames(files);

  console.info(`Found ${songFiles.length} sound files`);
  await Promise.all(songFiles.map(searchForMetadata));

  const selections = forReview.map((fr) => {
    console.info(`
Do any of the following match "${fr.fileName}"?

${fr.results.reduce(
  (acc, current, index) =>
    `${acc} ${index + 1} - ${current.name} (similarity: ${Math.round(
      current.similarity * 100
    )}%) \n`,
  ""
)}
    
    `);

    const getUserSelection = () => {
      const input = prompt("Enter the corresponding number, or s to skip: ");

      if (input === "s") {
        console.log("\nskipping");
        return fr;
      }
      const int = Number(input);
      if (isNaN(int) || int > fr.results.length) {
        console.log(`${input} is not valid, please try again.`);
        return getUserSelection();
      }
      console.log(`\nYou selected ${int} - ${fr.results[int - 1].name}`);

      return { ...fr, selectedIndex: int - 1 };
    };

    return getUserSelection();
  });

  selections.forEach((item) => {
    if (item.selectedIndex === undefined) {
      return;
    }

    const { siteIndex, results, selectedIndex, fileName } = item;
    const site = sites[siteIndex];
    const slug = results[selectedIndex].href;
    const songPageUrl = `${site.baseUrl}${slug}`;

    getDataFromSongPageAndWrite(songPageUrl, site, fileName);
  });
};

getFiles(filePath, processAllFiles);
