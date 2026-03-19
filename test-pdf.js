import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
console.log('pdfParse type:', typeof pdfParse);
console.log('pdfParse keys:', Object.keys(pdfParse));
if (typeof pdfParse === 'function') {
    console.log('pdfParse is a function');
} else if (pdfParse.default && typeof pdfParse.default === 'function') {
    console.log('pdfParse.default is a function');
} else {
    console.log('Neither pdfParse nor pdfParse.default is a function');
}
