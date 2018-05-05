'use strict';

const http = require('http');
const PORT_HTTP = process.env.PORT || 8089;
const PORT_WSS  = process.env.PORT_WSS || 8090;
const fs = require('fs');
const url = require('url');
const path = require('path');
const WebSocket = require('ws');
const StreamsManager = require('./StreamsManager');



// HTTP server
// ===========
let server = http.createServer((req, res) => {
  let stm;
  const parsedUrl = url.parse(req.url);
  let pathname = `.${parsedUrl.pathname}`;
  switch (pathname) {
    // Dynamic uris
    case './play_video_segments_over_websockets':
    case './play_video_segments_over_http':
    case './play_video_file':
      stm = fs.createReadStream(__dirname+'/../dist_public/'+pathname+'/index.html');
      stm.pipe(res);
      break;
    // Static uris
    default:
      pathname = pathname.replace(/^\.\//, __dirname+'/../dist_public/');
      pathname = pathname.replace(/\\/g,'/');
      const ext = path.parse(pathname).ext;
      const map = {
        '.ico': 'image/x-icon',
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword'
      };
      fs.exists(pathname, function(exist) {
        if(!exist) {  // The file is not found
          res.statusCode = 404;
          res.end(`File ${pathname} not found!`);
          return;
        }
        // If is a directory search for index file matching the extention
        if (fs.statSync(pathname).isDirectory()) pathname += '/index' + ext;
        // Read file from file system
        res.setHeader('Content-type', map[ext] || 'text/plain' );
        stm = fs.createReadStream(pathname);
        stm.pipe(res);
      });
      break;
  }
}).on('error', (err) => {
  console.error('ERROR:'+err.message);
});
server.listen(PORT_HTTP, (err) => {  
  if (err)  return console.error('ERROR: http server could not be started', err);
  console.log(`[http] - Http server is listening on: http://localhost:${PORT_HTTP}`);
});





// Media server (over websockets)
// ==============================
var wss = new WebSocket.Server({ port:PORT_WSS });
console.log(`[wss] - Wss server is listening on: ws://localhost:${PORT_WSS}`);
function noop() {}
function heartbeat() { this.isAlive = true; }
wss.on('connection', (ws, req)=> {
  const parsedUrl = url.parse(req.url, true);
  console.log(`[wss] - New client connected to url [${req.url}]. Total number of websockets clients:[${wss.clients.size}]`);  // NOTE: wss.clients is a javascript Set object (See:https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  streamsManager.subscribeClientToRequestedStream(ws, req);
  ws.on('close', ()=>{
    console.log(`[wss] - Client id [${ws.id}] disconnected. Total number of websockets clients:[${wss.clients.size}]`);
    streamsManager.unsubscribeNonActiveClients();
  });
});
const interval = setInterval(()=> {
  wss.clients.forEach((ws)=> {
    if (ws.isAlive === false) {
      console.log(`[wss] - Client id [${ws.id}] disconnected`);
      let r = ws.terminate();
      streamsManager.unsubscribeNonActiveClients();
      return r;
    }
    ws.isAlive = false;
    ws.ping(noop);
  });
}, 3000);




// Let's create a new instance of the StreamsManager class.
// This class is used to define which streams are available in the system, and it controls the streaming of each individual stream over websockets.
// It takes care of clients that may subscribe to a specific stream id.
// All clients receive the media segments from the current playback position for each stream.
// When a stream reaches the end, the streaming is stopped.
// If the streaming for a particular stream is stopped and a new client subscribes to it, streaming will start over again.
// If the streaming for a particular stream is running and a new client subscribes to it, streaming will keep going on from current playback position.
/* NOTES:

   We will create a 'streams' object with the following structure:
     streams{streamId}
       id
       segmentsDurationMs   // The following prop is the approx average duration of the segments. It should be the same value as the one in the -dash arg used by MP4Box when the dash segments where generated at the server side
       asyncIdStreaming     // This is the id for the setInterval that will be sending the segments periodically to all clients. When streaming starts, this will have a value other than null. If streaming is stopped/finished, this will be null
       tracks{trackId}
         id
         codec
         kind
         type
         language
         name
         iSegmentFirst
         iSegmentLast
         iSegmentSent       // The i of the last segment that has been sent to the clients
       clients[]
         ws
         initializationSegmentSent
         
       
   Steps to take:
   . Before running the project, use mp4box to generate DASH segments for audio and video of the stream we want to serve.
   . Then we enter the stream details here when initing the streamsManager
   . It's important to fill-up the tracks array of the stream. This array contains a list of track objects. A track object has properties like: { id, codec, kind, type, language, name, iSegmentFirst, iSegmentLast, iSegmentSent }
   . We are now ready to listen to websocket clients
   . We start sending data through the websocket to all clients. We do it periodically every X ms (where X is the dash param used by mp4box). In the setInterval funcion:
     . For each stream:
       . If there are no clients connected to that stream id, we rewind the tracks associated to that stream to the 1st segment! The iSegmentSent prop is set to null in all tracks.
       . If there are clients connected to that stream id:
         . We increase the stream.track.iSegmentSent by 1 of all tracks (if it is null we make it 0)
         . For each track:
           . If stream.track.iSegmentSent is bigger than the number of segments for that track, we do NOT send any segment to the clients, and set the iSegmentSent to null
           . ... otherwise we send a frame composed by:  [media stream management header/data]+[data buffer]   and increase the ntracksSent in 1
         . If ntracksSent is 0, then we send a  [media stream management header/close]  frame
   . Now, if a new client connects to the websocket server:
     . We check if the stream id exists. If it does we add it to the streams[streamId].clients[] array
   . If a new client disconnects from the websocket server, we remove it from the streams[streamId].clients[] array
*/
var streamsManager = new StreamsManager(wss, {
  '37': {
    id:37,
    name: 'tears_of_steel_1280x534',
    clients:[],
    segmentsDurationMs: 2000,
    tracks: [
      {id:1, codec:'avc3.64001F', type:'video', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Video Handler', iSegmentFirst:1, iSegmentLast:11, iSegmentSent:null},
      {id:2, codec:'mp4a.40.2',   type:'audio', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Audio Handler', iSegmentFirst:1, iSegmentLast:11, iSegmentSent:null}    
    ],
  },
  '52': {
    id:52,
    name: 'bunny_720x480',
    clients:[],
    segmentsDurationMs: 2000,
    tracks: [
      {id:1, codec:'avc3.4D401E', type:'video', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Video Handler', iSegmentFirst:1, iSegmentLast:11, iSegmentSent:null},
      {id:2, codec:'mp4a.40.2',   type:'audio', kind:{schemeURI:'', value:''}, language:'und', name:'L-SMASH Audio Handler', iSegmentFirst:1, iSegmentLast:11, iSegmentSent:null}    
    ],
  }  
});