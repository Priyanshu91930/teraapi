import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
await mongoose.connect(uri, { bufferCommands: false });
const db = mongoose.connection.getClient().db('cloned_vjbotz');
const col = db.collection('app_users');

const sample = await col.findOne({});
console.log('SAMPLE KEYS:', Object.keys(sample || {}).join(', '));

const emailQuery = { email: { $exists: true, $ne: null, $ne: '' } };
const withEmail = await col.countDocuments(emailQuery);
console.log('docs with email field:', withEmail);

const sample2 = await col.findOne(emailQuery);
if (sample2) console.log('SAMPLE WITH EMAIL:', JSON.stringify(sample2, null, 2).slice(0, 1000));

const all = await col.find({}, { projection: { email: 1, name: 1, _id: 1 } }).toArray();
console.log('--- ALL EMAILS ---');
all.forEach((d) => console.log(JSON.stringify(d)));
await mongoose.disconnect();
