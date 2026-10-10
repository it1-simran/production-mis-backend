// db.js
const mongoose = require('mongoose');
const dns = require('dns');

// Some Windows setups expose only a link-local IPv6 resolver (e.g. fe80::1)
// that refuses Node's c-ares SRV queries, breaking mongodb+srv:// lookups even
// though the OS resolver works. Prepend reliable public resolvers so Atlas SRV
// records can always be resolved, while keeping the system resolvers as fallback.
const ensureDnsResolvers = () => {
    try {
        const existing = dns.getServers();
        const publicResolvers = ['8.8.8.8', '1.1.1.1'];
        const merged = [
            ...publicResolvers,
            ...existing.filter((server) => !publicResolvers.includes(server)),
        ];
        dns.setServers(merged);
    } catch (err) {
        console.warn('Could not adjust DNS resolvers:', err.message);
    }
};

const connectDB = async () => {
    try {
        ensureDnsResolvers();
        await mongoose.connect(process.env.MONGODB_URI, {
            autoIndex: false,  // We manage indexes manually (see fix-final.js)
            // Raised from 50: this is a per-process client-side cap, independent of
            // Atlas's own connection limit. Live cluster stats (2026-09-18) showed
            // only 130/~3000 connections in use with 0 rejected - the Atlas cluster
            // itself had ample headroom while requests (including transaction starts)
            // were still queueing/stalling for 13+ seconds waiting on THIS process's
            // own pool, which was the actual bottleneck, not the database.
            maxPoolSize: 150,
            minPoolSize: 5,
            maxIdleTimeMS: 30000,
            socketTimeoutMS: 45000,
            serverSelectionTimeoutMS: 10000,
        });
        console.log('Connected !!');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        process.exit(1);  // Exit the process with failure
    }
};

module.exports = connectDB;
