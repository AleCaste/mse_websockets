
## Web video/audio player and server

* This project was developed using `Windows 7`, `node v8.4.0`, `npm v6.0.0` <br />
* There are 3 sub-projects within it:
  1. The **play_video_file** sub-project: the whole video file downloads over http and is segmented on the client side.
  2. The **play_video_segments_over_http** sub-project: the video file is segmented on the server side and the segments are downloaded over http by the client.
  3. The **play_video_segments_over_websockets** sub-project: the video file is segmented on the server and the segments are downloaded over websockets by the client.
* The main one is the **play_video_segments_over_websockets**, the other two were for me (to test different features in the process).
* In all of them the web player uses MSE (Media Source Extensions) to play the media content.
* Tested on Chrome Version 66.0.3359.117, Firefox Developer Edition 61.0b2 which have good MSE support.
* The backend runs 2 servers:
  1. An http server that serves static files (.html, .js, etc)
  2. An wss server that serves data through websockets
* The backend is written using ES6 features
* The frontend is written in ES5 (I could use ES6 features too since if a browser that supports MSE does support ES6 too, but well, just as a proof of concept)
  
### Running the project

Download the project into the folder you want and install the dependencies (only 2 minor dependencies: `uuid` and `ws`):<br />
`npm install`<br />
You can now start the backend server by executing:<br />
`npm start`<br />
Now you can open an internet browser like Chrome or Firefox and open one of the following pages:  
* `http://localhost:8089/play_video_segments_over_websockets`
* `http://localhost:8089/play_video_segments_over_http`
* `http://localhost:8089/play_video_file`



  
### Project folder structure

The backend files are stored in `[project-folder]/node_app_backend`
The public folder with the files the server delivers to the clients is `[project-folder]/dist_public`
Within it you can find:
* The media files `[project-folder]/dist_public/media`
* The .html pages for all the sub-projects:
  * `[project-folder]/dist_public/play_video_segments_over_websockets/index.html`
  * `[project-folder]/dist_public/play_video_segments_over_http/index.html`
  * `[project-folder]/dist_public/play_video_file/index.html`  



### Sub-projects  
#### play_video_file
This sub-project was created by me, just to test some features.
The media content is segmentated on the client side. <br />
The player downloads the WHOLE video file. <br />
But it does not wait for the full download to be finished. <br />
Instead, it tries to start processing the data as it arrives. <br />
As soon as it can, it extracts the mp4 file details (with info about the different tracks etc). <br />
The client itself segmentates the binary chunks into mp4 segments (as the data keeps coming through the downloading process). <br />
It then plays the mp4 segments (starting the playback even when the downloading process has not finished). <br />

#### play_video_segments_over_http
This sub-project was created by me, just to test some features.
You can (or not) specify the stream you want to play using one of the following urls in the browser: <br />
* `http://localhost:8089/play_video_segments_over_http`
* `http://localhost:8089/play_video_segments_over_http?id=37`
* `http://localhost:8089/play_video_segments_over_http?id=52`

The media content is segmentated on the server side. <br />
DASH media segments are pre-generated using MP4BOX for all the streams we want to serve. <br />
We have segments for the video-only track, and segments for the audio-only track. <br />
On the client side the segments are downloaded sequentially over http. <br />
The initialization segment is ALWAYS downloaded first. <br />
Then we can start downloading the segments at any position we want (it does NOT necessarily needs to be from the beginning). <br />

#### play_video_segments_over_websockets
This is the important sub-project.
You can (or not) specify the stream you want to play using one of the following urls in the browser:
* `http://localhost:8089/play_video_segments_over_websockets`
* `http://localhost:8089/play_video_segments_over_websockets?id=37`
* `http://localhost:8089/play_video_segments_over_websockets?id=52`

The media content is segmentated on the server side. <br />
DASH media segments are pre-generated using MP4BOX for all the streams we want to serve. <br />
We have segments for the video-only track, and segments for the audio-only track. <br />
On the client side the segments are downloaded sequentially over websockets. <br />
The initialization segment is ALWAYS downloaded first. <br />
Then the player may receive segments from any position the stream is currently playing at. <br />
Segments are encapsulated in frames according to the following spec:

---  
##### Media Stream Management Header
**Frame Sequence Number**
An unsigned 32 bit (4 byte) value. The value begins with 1 (zero is invalid), and increments for each frame header/data pair. <br />
**Frame Type**
A single 8 bit character value. This value is used to signify the "type" of frame. <br /> 
Values are as follows:
```
"H" = Header frame.
"D" = Data frame.
"N" = Null frame (no data).
"A" = ACK frame (acknowledgment).
"E" = Error frame.
"C" = Close frame (request WebSocket close).
```
**Frame Data Type**
A single 8 bit character value. This value is used to signify the "type" of data in the frame. <br />
Values are as follows:
```
"S" = Audio data.
"V" = Video data.
"I" = Still image data.
"M" = Meta data.
"T" = Text data
"X" = Multi-format data
```
---
##### Data block
The data block is only appended when **Frame Type** is "D"

---
The websocket data is served from the route:
```ws://localhost:8090/?type=sink&id=[id]```
... where [id] is the stream id we want to play


##### Notes about how the server serves the streams over websockets
* Each stream has a numeric id (e.g. 37)
* Each stream consists of an initialization segment, video segments, and audio segments (all in separate individual files)
* The segment files have been pre-generated by MP4Box using the following command (where XXXXXX is the name of the base media file):
```MP4Box -dash 2000 -bound -profile dashavc264:live -segment-name XXXXXX.dash.$RepresentationID$.$Number$ XXXXXX.mp4#video XXXXXX.mp4#audio```
* So each video segment should include about 60 frames (if video is 30fps). Meaning 2s of video data approx.
* If a client subscribes to a stream, the streaming process of that stream begins.
* If additional clients subscribe to that same stream, they will get the content from the point the live stream is currently at.
* When the live stream reaches its end, a `Close` frame is sent to the clients to tell them that the stream has finished.
* Once a stream has stopped, it won't be re-run again until a new client subscribes to it.
* When this happens the server will start the streaming from the beginning.
* **NOTE:** The video autoplays just fine from Firefox, but I have not been able to get the autoplay working on Chrome (even when adding the 'muted' attribute to the <video> tag) so I'd need to further investigate on it).
