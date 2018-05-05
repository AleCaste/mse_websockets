'use strict';

const util = require('util');
const fs = require('fs');
  fs.$readFile = util.promisify(fs.readFile);
const url = require('url');
const path = require('path');
const WebSocket = require('ws');
const uuidv4 = require('uuid/v4');


// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// This class is used to define which streams are available in the system, and it controls the streaming of each individual stream over websockets.
// It takes care of clients that may subscribe to a specific stream id.
// All clients receive the media segments from the current playback position for each stream.
// When a stream reaches the end, the streaming is stopped.
// If the streaming for a particular stream is stopped and a new client subscribes to it, streaming will start over again.
// If the streaming for a particular stream is running and a new client subscribes to it, streaming will keep going on from current playback position.
class StreamsManager {
  // ----------------------------------------------------------------------------
  constructor(wss, streams) {
    let t = this;
    t.wss = wss;
    t.streams = streams;
  }
  // ----------------------------------------------------------------------------
  subscribeClientToRequestedStream(ws, req) {
    let t = this;
    let streams = t.streams;
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.pathname=='/' && parsedUrl.query.type=='sink' && streams[parsedUrl.query.id]!=null) {
      ws.id = uuidv4();
      let stream = streams[parsedUrl.query.id];
      stream.clients.push({ws:ws, initializationSegmentSent:false});
      t.unsubscribeNonActiveClients(stream);  // Go through current clients array associated to the stream and remove those clients that are NO longer active
      console.log(`[streamsManager] - Client id [${ws.id}] subscribed to stream [${parsedUrl.query.id}]. Total number clients for this stream:[${stream.clients.length}]`);
      t.startStreaming(stream); // Let's start the streaming of the subscribed stream (in case is not currently running)
    }
  }
  // ----------------------------------------------------------------------------
  // Go through all the clients in the stream.clients array and check if that client is currently active.
  // If it is NOT, it will be removed from the stream.clients array.
  // If NO stream is specified, the function will perform this action in ALL registered streams.
  unsubscribeNonActiveClients(stream) {
    let t = this;
    let wss = t.wss;
    let streams = t.streams;
    let unsubscribeNonActiveClientsFromStream = (stream)=> {
      let ws;
      let i = stream.clients.length-1; while(i>=0) {
        ws = stream.clients[i].ws;
        if (wss.clients.has(ws)===false)  stream.clients.splice(i,1);
        i--;
      }
      console.log(`[streamsManager] - Stream id [${stream.id}] total number of clients for this stream:[${stream.clients.length}]`);
    };
    if (stream!=null)                         unsubscribeNonActiveClientsFromStream(stream);
    else Object.keys(streams).forEach((key)=> unsubscribeNonActiveClientsFromStream(streams[key]));
  }
  // ----------------------------------------------------------------------------
  // Start delivering segments to all clients subscribed to the specified stream.
  // The segments are sent periodically with an interval that depends on the duration of the segments.
  // The method keeps the current playback position (through the 'iSegmentSent' prop of each track associated to the stream).
  // If all segments of all tracks are sent, then the streaming is stopped.
  // If the streaming for the stream is stopped and a new client subscribes to it, streaming will start over again.
  // If the streaming for the stream is running and a new client subscribes to it, streaming will keep going on from current playback position.
  startStreaming(stream) {
    let t = this;
    let wss = t.wss;
    if (stream==null || t.isStreaming(stream)==true)  return;  // No stream specified, or we are already streaming it!
    stream.asyncIdStreaming = setInterval(()=> {
      if (stream.clients.length==0) {
        // There are no clients subscribed to this stream, so we stop the streaming.
        t.stopStreaming(stream);
      } else {
        // We have at least 1 client currently subscribed to this stream. Let's keep streaming from the playback cursor (the 'iSegmentSent' prop for each track within the stream)
        let ntracksSent = 0;
        stream.tracks.forEach((track)=> {
          track.iSegmentSent = (track.iSegmentSent==null) ? track.iSegmentFirst : track.iSegmentSent+1;
          if (track.iSegmentSent>track.iSegmentLast) {
            // No more segments to send on this track. So we set the cursor to null.
            track.iSegmentSent = null;
          } else {
            // Send a  [media stream management header/data]+[data buffer]  frame
            ntracksSent++;
            console.log(`  [streamsManager] - Stream id [${stream.id}] running. Playback cursor at Track[${track.id}].Segment[${track.iSegmentSent}]`);
            stream.clients.forEach((client)=> {
              (async function() {
                let ws = client.ws;
                let frame;
                if (client.initializationSegmentSent==false) {
                  console.log(`    [streamsManager] - Stream[${stream.id}].Client[${ws.id}].Track[${track.id}].Segment[${track.iSegmentSent}] - Not sending yet!. Let's send the initializationSegment first!`);
                  frame = await t.buildFrame(stream, track, 0, 'D');
                  if (frame!=null)  ws.send(frame);
                  client.initializationSegmentSent = true;
                }
                console.log(`    [streamsManager] - Stream[${stream.id}].Client[${ws.id}].Track[${track.id}].Segment[${track.iSegmentSent}] - Sending`);
                frame = await t.buildFrame(stream, track, track.iSegmentSent, 'D');
                if (frame!=null)  ws.send(frame);
              }());
            });
          }
          
        });
        if (ntracksSent==0) {
          // Send a  [media stream management header/close]  frame
          t.stopStreaming(stream);  // And now we can stop the streaming
        }
      }
    }, stream.segmentsDurationMs);
    console.log(`[streamsManager] - Stream id [${stream.id}] started.`);
  }
  // ----------------------------------------------------------------------------
  // Stops the streaming of the specified stream
  stopStreaming(stream) {
    let t = this;
    if (stream==null)  return;
    if (stream.asyncIdStreaming!=null)  { clearInterval(stream.asyncIdStreaming); stream.asyncIdStreaming = null; }
    // We need to set the 'iSegmentSent' prop of all tracks to null (this is like the playback cursor).
    stream.tracks.forEach((track)=> {
      track.iSegmentSent = null;
    });
    // Send a 'Close' frame to all subscribed clients
    stream.clients.forEach((client)=> {
      (async function() {
        let ws = client.ws;
        let frame = await t.buildFrame(stream, null, null, 'C');
        if (frame!=null)  ws.send(frame);
      }());
    });
    console.log(`[streamsManager] - Stream id [${stream.id}] stopped.`);
  }
  // ----------------------------------------------------------------------------
  // Checks if streaming is running for the specified stream
  isStreaming(stream) {
    return ((stream && stream.asyncIdStreaming!=null) ? true : false);
  }
  // ----------------------------------------------------------------------------
  // If 'iSegment' equals 0 the method will send the initialization segment.
  // Otherwise 'iSegment' needs to be an integer that specifies the segment number to get.
  // IMPORTANT! This method returns a Uint8Array (not an ArrayBuffer)
  async getSegmentFromFileSystem(stream, track, iSegment) {
    let t = this;
    if (stream==null || track==null || iSegment==null)  return;
    let fileRoute;
    if (iSegment==0)  fileRoute = `${__dirname}/../dist_public/media/${stream.name}.dash.${track.id}..mp4`;
    else              fileRoute = `${__dirname}/../dist_public/media/${stream.name}.dash.${track.id}.${iSegment}.m4s`;
    let buffer = await fs.$readFile(fileRoute);  // It returns a Uint8Array. You may check this running:  Object.prototype.toString.call(buffer)  --> [object Uint8Array]
    //console.log('fileRoute:'+fileRoute);
    //console.log('bufferNull?'+(buffer==null)+'    Type:'+Object.prototype.toString.call(buffer)+'    byteLength:'+buffer.byteLength);
    return buffer;
  }
  // ----------------------------------------------------------------------------
  async buildFrame(stream, track, iSegment, frameType) {
    let t = this;
    let endianness, buffer, tbuffer, vbuffer, tbufferData, p, v;
    // p stands for Position (in bytes)
    // v stands for value
    
    try { 
      if (frameType==null)  frameType = 'D';
      
      endianness = 'big_endian';  // little_endian | big_endian
        // little_endian: used in files and local processing in x84 based computers (this is the default)
        // big_endian: used in network transmission (TCP/IP) by convention. It's not because of performance reasons, it's simply the convention.
        endianness = 'big_endian' ? false : true;
        
      // Get data buffer associated to the specified segment
      if (frameType=='D') {
        tbufferData = await t.getSegmentFromFileSystem(stream, track, iSegment);
      }
        
      // Frame length in bytes
      v = (32+8+8)/8 + ((tbufferData && tbufferData.byteLength)||0);
      tbuffer = new Uint8Array(v);
      buffer = tbuffer.buffer;
      vbuffer = new DataView(buffer);
      
      // ==== [media stream management header/data] ====
      p = 0;
      // Frame Sequence Number
      v = iSegment || 0;
      vbuffer.setUint32(p, v, endianness); p += 32/8;
      // Frame Type
      v = frameType.charCodeAt(0);
      vbuffer.setUint8(p, v); p += 8/8;
      // Frame Data Type
      v = v = 'X'.charCodeAt(0);
      if (frameType=='D') {
        if (track.type=='video')       v = 'V'.charCodeAt(0);
        else if (track.type=='audio')  v = 'S'.charCodeAt(0);
      }
      vbuffer.setUint8(p, v); p += 8/8;
      
      // ==== [data buffer] ====
      if (frameType=='D' && tbufferData && tbufferData.byteLength && tbufferData.byteLength>0) {
        v = tbufferData;
        tbuffer.set(v, p); p += tbufferData.byteLength;
      }
    } catch(e) {
      console.log('ERROR:', e);
    }
    
    return buffer;
  }
  // ----------------------------------------------------------------------------
}
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

module.exports = StreamsManager;