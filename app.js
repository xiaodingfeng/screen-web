// 录屏应用的JavaScript代码

// 全局变量
let mediaRecorder;
let recordedChunks = [];
let stream;
let isRecording = false;
let isPaused = false;
let recordedVideoUrl = null;
let recordings = [];
let recordingStartTime = null;
let recordingTimer = null;
let fileSize = 0;
let autoSaveTimer = null;
let temporaryRecordings = []; // 临时存储录制片段
let currentRecordingId = null; // 当前录制的唯一标识
let chunkSizeLimit = 50 * 1024 * 1024; // 50MB before forced save/merge

// 获取DOM元素
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const preview = document.getElementById('preview');
const status = document.getElementById('status');
const recordingsContainer = document.getElementById('recordingsContainer');
const videoElement = preview.querySelector('video');
const qualitySelect = document.getElementById('qualitySelect');
const frameRateSelect = document.getElementById('frameRateSelect');
const audioToggle = document.getElementById('audioToggle');
const advancedToggle = document.getElementById('advancedToggle');
const advancedOptions = document.getElementById('advancedOptions');
const bitrateSelect = document.getElementById('bitrateSelect');
const durationLimit = document.getElementById('durationLimit');
const autoSaveInterval = document.getElementById('autoSaveInterval');
const recordingInfo = document.getElementById('recordingInfo');
const recordingTime = document.getElementById('recordingTime');
const fileSizeElement = document.getElementById('fileSize');
const memoryUsage = document.getElementById('memoryUsage');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');

// 事件监听器
startBtn.addEventListener('click', startRecording);
pauseBtn.addEventListener('click', pauseRecording);
stopBtn.addEventListener('click', stopRecording);
saveBtn.addEventListener('click', saveRecording);
advancedToggle.addEventListener('click', toggleAdvancedSettings);

// IndexedDB数据库配置
const DB_NAME = 'ScreenRecorderDB';
const DB_VERSION = 4; // Update version to handle data format changes
const STORE_NAME = 'recordings';
const TEMP_STORE_NAME = 'temp_recordings'; // 临时存储录制片段

// 打开IndexedDB数据库
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const version = event.oldVersion;
            
            // If upgrading from an older version, handle the store creation
            if (version < 1) {
                // 创建录制记录存储
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
            
            if (version < 2) {
                // 创建临时录制片段存储
                const tempStore = db.createObjectStore(TEMP_STORE_NAME, { keyPath: 'id', autoIncrement: true });
                tempStore.createIndex('recordingId', 'recordingId', { unique: false });
            }
            
            // If upgrading to version 3 or higher, ensure stores exist
            if (version < 3) {
                // Stores already exist from previous versions, nothing to do
            }
            
            // Version 4: Ensure stores exist and are properly configured
            if (version < 4) {
                // Check if stores exist, if not create them (should already exist)
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
                
                if (!db.objectStoreNames.contains(TEMP_STORE_NAME)) {
                    const tempStore = db.createObjectStore(TEMP_STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    tempStore.createIndex('recordingId', 'recordingId', { unique: false });
                }
            }
        };
    });
}

// 保存录制到IndexedDB
async function saveRecordingToDB(recording) {
    try {
        // First, convert the blob to array buffer
        const arrayBuffer = await blobToArrayBuffer(recording.blob);
        
        // Then save to IndexedDB in a separate operation
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        return new Promise((resolve, reject) => {
            const request = store.add({
                blobData: arrayBuffer,
                timestamp: recording.timestamp.toISOString(),
                createdAt: new Date(),
                duration: recording.duration || 0,
                size: recording.size || 0,
                mimeType: recording.mimeType || 'video/webm',  // Save the mimeType
                title: recording.title || `录制 ${recordings.length + 1}`,  // Save the title
                customTitle: recording.customTitle  // Save if it's a custom title
            });
            
            request.onsuccess = (event) => {
                // Resolve with the new record's ID
                resolve(event.target.result);
            };
            request.onerror = (event) => {
                console.error('IndexedDB 添加请求错误:', event);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('保存录制到数据库时出错:', error);
        throw error;
    }
}

// Helper function to convert blob to array buffer
function blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function() {
            resolve(reader.result);
        };
        reader.onerror = function() {
            reject(new Error('无法读取录制文件'));
        };
        reader.readAsArrayBuffer(blob);
    });
}

// 保存临时录制片段到IndexedDB
async function saveTempRecordingToDB(chunk, recordingId) {
    try {
        const db = await openDB();
        const transaction = db.transaction(TEMP_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(TEMP_STORE_NAME);
        
        return new Promise((resolve, reject) => {
            const request = store.add({
                data: chunk,
                recordingId: recordingId,
                timestamp: new Date()
            });
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('保存临时录制片段到数据库时出错:', error);
        throw error;
    }
}

// 从临时存储加载录制片段并合并
async function loadAndMergeTempRecordings(recordingId) {
    try {
        const db = await openDB();
        const transaction = db.transaction(TEMP_STORE_NAME, 'readonly');
        const store = transaction.objectStore(TEMP_STORE_NAME);
        const index = store.index('recordingId');
        const request = index.getAll(IDBKeyRange.only(recordingId));
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const chunks = request.result
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .map(record => record.data);
                
                if (chunks.length > 0) {
                    // Use the original type if possible, otherwise default to webm
                    const mergedBlob = new Blob(chunks, { type: 'video/webm' });
                    resolve(mergedBlob);
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('加载和合并临时录制片段时出错:', error);
        return null;
    }
}

// 删除指定录制的临时片段
async function deleteTempRecordings(recordingId) {
    try {
        const db = await openDB();
        const transaction = db.transaction(TEMP_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(TEMP_STORE_NAME);
        const index = store.index('recordingId');
        const request = index.openCursor(IDBKeyRange.only(recordingId));
        
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
    } catch (error) {
        console.warn('删除临时录制片段时出错:', error);
    }
}

// 从IndexedDB加载所有录制
async function loadRecordingsFromDB() {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('timestamp');
        
        return new Promise((resolve, reject) => {
            const request = index.getAll();
            
            request.onsuccess = () => {
                const recordings = [];
                
                for (const record of request.result) {
                    try {
                        let blob;
                        let mimeType = record.mimeType || 'video/webm'; // Use stored mimeType if available, otherwise default to webm
                        if (record.blobData) {
                            // New format: blob stored as arrayBuffer
                            blob = new Blob([record.blobData], { type: mimeType });
                        } else if (record.blob) {
                            // Fallback for records stored directly as blobs
                            blob = record.blob;
                        } else {
                            // Fallback for any malformed records
                            blob = new Blob([], { type: mimeType });
                        }
                        
                        // Create a valid recording object
                        // Don't create URL here, we'll create it as needed
                        const recordingObj = {
                            blob: blob,
                            timestamp: new Date(record.timestamp),
                            id: record.id,
                            // url will be created when needed
                            duration: record.duration || 0,
                            size: record.size || 0,
                            title: record.title || record.customTitle || `录制 ${recordings.length + 1}`, // Use saved title or default
                            customTitle: record.customTitle, // Preserve custom title flag
                            mimeType: mimeType,  // Store the mimeType for reference
                            // Add a method to get the URL when needed
                            getUrl: function() {
                                if (!this._url) {
                                    this._url = URL.createObjectURL(this.blob);
                                }
                                return this._url;
                            }
                        };
                        
                        recordings.push(recordingObj);
                    } catch (error) {
                        console.error('Error processing individual recording:', error, record);
                        // Skip this record if it's problematic
                        continue;
                    }
                }
                
                resolve(recordings);
            };
            
            request.onerror = (event) => {
                console.error('IndexedDB 查询错误:', event);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('从数据库加载录制时出错:', error);
        return [];
    }
}

// 从IndexedDB删除录制
async function deleteRecordingFromDB(id) {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('从数据库删除录制时出错:', error);
        throw error;
    }
}

// 检查是否支持录屏功能
function checkScreenRecordingSupport() {
    // 检查是否在安全上下文（HTTPS或localhost）
    const isSecureContext = window.isSecureContext;
    
    // 检查浏览器是否支持所需API
    const isSupported = navigator.mediaDevices && window.MediaRecorder;
    
    // 检查是否为移动设备
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // 检查是否支持getDisplayMedia（移动端通常不支持）
    const supportsGetDisplayMedia = typeof navigator.mediaDevices.getDisplayMedia === 'function';
    
    return {
        isSecureContext,
        isSupported,
        isMobile,
        supportsGetDisplayMedia,
        canRecord: isSecureContext && isSupported && supportsGetDisplayMedia && !isMobile
    };
}

// 显示详细的错误信息
function showDetailedErrorMessage() {
    const support = checkScreenRecordingSupport();
    
    let message = '';
    
    if (support.isMobile) {
        message = '移动设备不支持屏幕录制功能。请使用桌面浏览器（如Chrome、Firefox或Edge）访问此页面。';
    } else if (!support.isSupported) {
        message = '您的浏览器不支持录屏功能。请使用最新版本的Chrome、Firefox或Edge浏览器。';
    } else if (!support.supportsGetDisplayMedia) {
        message = '您的浏览器不支持屏幕共享功能。请更新浏览器或使用其他支持的浏览器。';
    } else if (!support.isSecureContext) {
        message = '录屏功能需要在安全环境下运行。请确保您使用的是HTTPS协议访问此页面，或者在本地开发环境（localhost）下运行。';
    } else {
        message = '录屏功能当前不可用，请检查浏览器权限设置。';
    }
    
    // 更新状态显示
    updateStatus(message, 'stopped');
    
    // 在页面上显示详细信息
    const errorInfo = document.createElement('div');
    errorInfo.className = 'error-info';
    errorInfo.innerHTML = `
        <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin: 10px 0;">
            <h3 style="color: #856404; margin-top: 0; font-size: 1.1rem;">
                <i class="fas fa-exclamation-triangle"></i> 录屏功能不可用
            </h3>
            <p style="font-size: 0.95rem;">${message}</p>
            ${!support.isMobile && !support.isSecureContext ? `
            <div style="margin-top: 10px; padding: 10px; background: #f8f9fa; border-radius: 5px; font-size: 0.9rem;">
                <h4 style="margin-top: 0; color: #495057; font-size: 1rem;">解决方案：</h4>
                <ul style="margin: 8px 0; padding-left: 20px;">
                    <li>使用HTTPS协议访问此页面</li>
                    <li>或者在本地开发环境（localhost）下运行</li>
                    <li>确保浏览器有屏幕录制权限</li>
                    <li>检查浏览器的隐私设置</li>
                </ul>
            </div>` : ''}
        </div>
    `;
    
    // 如果是移动端，显示特殊提示
    if (support.isMobile) {
        const mobileWarning = document.createElement('div');
        mobileWarning.className = 'mobile-warning';
        mobileWarning.innerHTML = `
            <h3><i class="fas fa-mobile-alt"></i> 移动端限制说明</h3>
            <p>由于浏览器安全限制，移动设备（手机、平板）不支持屏幕录制功能。</p>
            <p>请使用以下方式录制屏幕：</p>
            <ul>
                <li>使用电脑浏览器访问此页面</li>
                <li>使用手机自带的屏幕录制功能</li>
                <li>使用专业的录屏应用</li>
            </ul>
        `;
        // 插入到控制面板中
        const panel = document.querySelector('.panel');
        if (panel) {
            panel.parentNode.insertBefore(mobileWarning, panel.nextSibling);
        }
    }
    
    // 插入到控制面板中
    const panel = document.querySelector('.panel');
    if (panel) {
        panel.parentNode.insertBefore(errorInfo, panel.nextSibling);
    }
}

// 根据选择的清晰度获取配置
function getQualityConfig(quality) {
    switch (quality) {
        case 'low':
            return {
                width: { ideal: 1280 },
                height: { ideal: 720 }
            };
        case 'medium':
            return {
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            };
        case 'high':
            return {
                width: { ideal: 2560 },
                height: { ideal: 1440 }
            };
        case 'ultra':
            return {
                width: { ideal: 3840 },
                height: { ideal: 2160 }
            };
        default:
            return {
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            };
    }
}

// 根据选择的比特率获取配置
function getBitrateConfig(bitrate) {
    switch (bitrate) {
        case 'low':
            return 2500000; // 2.5 Mbps
        case 'medium':
            return 5000000; // 5 Mbps
        case 'high':
            return 10000000; // 10 Mbps
        case 'ultra':
            return 20000000; // 20 Mbps
        default:
            return 5000000; // 5 Mbps
    }
}

// 切换高级设置显示
function toggleAdvancedSettings() {
    const icon = advancedToggle.querySelector('i');
    if (advancedOptions.classList.contains('active')) {
        advancedOptions.classList.remove('active');
        icon.className = 'fas fa-chevron-down';
        advancedToggle.innerHTML = '<i class="fas fa-chevron-down"></i> 高级设置';
    } else {
        advancedOptions.classList.add('active');
        icon.className = 'fas fa-chevron-up';
        advancedToggle.innerHTML = '<i class="fas fa-chevron-up"></i> 收起设置';
    }
}

// 格式化时间显示
function formatTime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// 更新录制信息显示
function updateRecordingInfo() {
    if (!recordingStartTime) return;
    
    const elapsed = (Date.now() - recordingStartTime) / 1000;
    recordingTime.textContent = formatTime(elapsed);
    
    // 更新文件大小显示
    fileSizeElement.textContent = `${(fileSize / (1024 * 1024)).toFixed(2)} MB`;
    
    // 更新内存使用显示（模拟）
    const memoryPercent = Math.min(95, Math.floor((fileSize / (100 * 1024 * 1024)) * 100));
    memoryUsage.textContent = `${memoryPercent}%`;
    
    // 更新进度条
    const limit = parseInt(durationLimit.value) * 60;
    const progress = Math.min(100, (elapsed / limit) * 100);
    progressFill.style.width = `${progress}%`;
    
    // 检查是否达到时长限制
    if (elapsed >= limit) {
        stopRecording();
        alert('录制已达到设定的时长限制，已自动停止录制。');
    }
}

// 开始录制计时器
function startRecordingTimer() {
    recordingStartTime = Date.now();
    recordingTimer = setInterval(updateRecordingInfo, 1000);
    recordingInfo.style.display = 'block';
    progressBar.style.display = 'block';
}

// 停止录制计时器
function stopRecordingTimer() {
    if (recordingTimer) {
        clearInterval(recordingTimer);
        recordingTimer = null;
    }
    recordingStartTime = null;
    recordingInfo.style.display = 'none';
    progressBar.style.display = 'none';
}

// 自动保存录制片段
function startAutoSaveTimer() {
    const interval = parseInt(autoSaveInterval.value) * 60 * 1000; // 转换为毫秒
    autoSaveTimer = setInterval(() => {
        if (isRecording && !isPaused && mediaRecorder && mediaRecorder.state === 'recording') {
            // 请求保存当前数据
            mediaRecorder.requestData();
            
            // 触发内存优化
            optimizeMemoryUsage();
        }
    }, interval);
}

// 停止自动保存计时器
function stopAutoSaveTimer() {
    if (autoSaveTimer) {
        clearInterval(autoSaveTimer);
        autoSaveTimer = null;
    }
}

// 内存优化：定期清理录制数据以防止浏览器卡顿
function optimizeMemoryUsage() {
    // 如果录制数据超过限制，自动触发数据保存并清空当前缓存
    if (fileSize > chunkSizeLimit) {
        console.log(`触发内存优化: 文件大小已达到 ${fileSize / (1024 * 1024)} MB`);
        
        // 请求当前数据并保存到IndexedDB
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.requestData();
        }
        
        // 清空当前收集的chunks以释放内存
        recordedChunks = [];
        fileSize = 0;
    }
    
    // 强制垃圾回收（如果可用）
    if (window.gc) {
        window.gc();
    }
}

// 开始录制
async function startRecording() {
    try {
        // 生成当前录制的唯一标识
        currentRecordingId = Date.now();
        
        // 获取配置
        const quality = qualitySelect.value;
        const qualityConfig = getQualityConfig(quality);
        const frameRate = parseInt(frameRateSelect.value);
        const audioEnabled = audioToggle.value === 'enabled';
        const micEnabled = document.getElementById('micToggle').value === 'enabled';
        const cameraEnabled = document.getElementById('cameraToggle').value === 'enabled';
        const bitrate = getBitrateConfig(bitrateSelect.value);
        
        // 创建MediaRecorder实例，设置高质量编码 - try MP4 first
        let options = {
            mimeType: 'video/mp4',
            videoBitsPerSecond: bitrate
        };

        // 检查浏览器支持的编码格式 - try different MP4 options first
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'video/webm; codecs=vp9,opus';
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm; codecs=vp8,vorbis';
                if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                    options.mimeType = 'video/webm';
                }
            }
        }

        // 构建getDisplayMedia约束
        const constraints = {
            video: {
                cursor: 'always',
                width: qualityConfig.width,
                height: qualityConfig.height,
                frameRate: { ideal: frameRate }
            },
            audio: audioEnabled  // This allows capturing system audio when available
        };
        
        // 获取屏幕共享流
        stream = await navigator.mediaDevices.getDisplayMedia(constraints);
        
        // If microphone is also enabled, get microphone stream and add it to the main stream
        if (micEnabled) {
            const micConstraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100
                }
            };
            
            try {
                const micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
                
                // Add microphone audio track to the screen stream
                const micAudioTrack = micStream.getAudioTracks()[0];
                if (micAudioTrack) {
                    stream.addTrack(micAudioTrack);
                }
            } catch (error) {
                console.error('无法获取麦克风权限:', error);
                alert('无法获取麦克风权限，将继续录制但不包含麦克风音频');
            }
        }
        
        // If camera is enabled, get camera stream and add it to the main stream
        if (cameraEnabled) {
            const cameraConstraints = {
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 15 }
                },
                audio: false  // We don't want to duplicate audio if it's already captured from screen/mic
            };
            
            try {
                const cameraStream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
                window.cameraStream = cameraStream; // Store reference for later cleanup
                
                // Create a canvas to composite screen and camera streams
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true }); // Optimize for frequent reads
                
                const screenVideo = document.createElement('video');
                screenVideo.srcObject = stream;
                screenVideo.play();
                
                const cameraVideo = document.createElement('video');
                cameraVideo.srcObject = cameraStream;
                cameraVideo.play();
                
                // Set canvas dimensions based on screen stream
                let targetFPS = Math.min(frameRate, 15); // Define targetFPS in outer scope
                screenVideo.onloadedmetadata = () => {
                    canvas.width = screenVideo.videoWidth;
                    canvas.height = screenVideo.videoHeight;
                    
                    // Position camera preview in corner
                    const previewWidth = Math.floor(canvas.width / 4);
                    const previewHeight = Math.floor(canvas.height / 4);
                    const previewX = canvas.width - previewWidth - 20; // 20px from right edge
                    const previewY = canvas.height - previewHeight - 20; // 20px from bottom edge
                    
                    // Optimized drawing function with frame skipping
                    let lastFrameTime = 0;
                    const frameInterval = 1000 / targetFPS;
                    
                    // Draw both video streams to canvas
                    function draw(timestamp) {
                        if (!stream.active) return; // Check if the stream is still active
                        
                        // Throttle frame rate to reduce CPU usage
                        if (timestamp - lastFrameTime >= frameInterval) {
                            ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
                            ctx.drawImage(cameraVideo, previewX, previewY, previewWidth, previewHeight);
                            
                            // Add a border around the camera preview
                            ctx.strokeStyle = 'white';
                            ctx.lineWidth = 2;
                            ctx.strokeRect(previewX, previewY, previewWidth, previewHeight);
                            
                            lastFrameTime = timestamp;
                        }
                        
                        requestAnimationFrame(draw);
                    }
                    
                    // Start drawing frames
                    requestAnimationFrame(draw);
                };
                
                // Create a new stream from the canvas
                // Use browser's preferred frame rate for capture
                const combinedStream = canvas.captureStream(targetFPS || frameRate || 30);
                
                // Add audio tracks if available
                const audioTracks = stream.getAudioTracks();
                audioTracks.forEach(track => {
                    combinedStream.addTrack(track);
                });
                
                // Replace the stream with the combined stream
                stream = combinedStream;
                
                // Show camera preview in a separate video element in the preview area
                const cameraPreview = document.getElementById('cameraPreview');
                if (cameraPreview) {
                    const videoElement = cameraPreview.querySelector('video');
                    if (videoElement) {
                        videoElement.srcObject = cameraStream;
                    }
                    cameraPreview.style.display = 'block';
                    
                    // Position camera preview in bottom-right of the preview area
                    cameraPreview.style.position = 'absolute';
                    cameraPreview.style.bottom = '10px';
                    cameraPreview.style.right = '10px';
                    cameraPreview.style.width = '160px';
                    cameraPreview.style.height = '120px';
                    cameraPreview.style.border = '2px solid white';
                    cameraPreview.style.borderRadius = '8px';
                    cameraPreview.style.zIndex = '10';
                }
            } catch (error) {
                console.error('无法获取摄像头权限:', error);
                alert('无法获取摄像头权限，将继续录制但不包含摄像头画面');
            }
        }

        // 创建MediaRecorder实例
        mediaRecorder = new MediaRecorder(stream, options);

        // 清空之前的录制数据
        recordedChunks = [];
        fileSize = 0;

        // 监听数据可用事件
        mediaRecorder.ondataavailable = async event => {
            if (event.data.size > 0) {
                // 只在非合并模式下添加到内存缓存（避免重复存储）
                if (event.type !== 'dataavailable' || recordedChunks.length === 0) {
                    recordedChunks.push(event.data);
                }
                
                fileSize += event.data.size;
                
                // 保存临时片段到数据库
                try {
                    await saveTempRecordingToDB(event.data, currentRecordingId);
                } catch (error) {
                    console.warn('保存临时录制片段失败:', error);
                }
                
                // 内存优化
                optimizeMemoryUsage();
            }
        };

        // 监听停止事件
        mediaRecorder.onstop = async () => {
            try {
                // 先尝试从临时存储加载所有录制片段
                let allChunks = [];
                
                // 如果内存中还有未保存的chunks，添加它们
                if (recordedChunks && recordedChunks.length > 0) {
                    allChunks = [...recordedChunks];
                }
                
                // 从IndexedDB加载临时录制片段并合并
                const tempBlob = await loadAndMergeTempRecordings(currentRecordingId);
                
                if (tempBlob) {
                    // 如果有临时片段，将其添加到总chunks中
                    allChunks.push(tempBlob);
                }
                
                // Determine the correct MIME type based on what was used for recording
                const mimeType = mediaRecorder.mimeType || 'video/webm';
                
                // 创建录制完成的视频Blob
                const blob = new Blob(allChunks, { type: mimeType });
                
                // 计算录制时长
                const duration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;
                
                // 保存录制记录
                const recording = {
                    blob: blob,
                    timestamp: new Date(),
                    duration: duration,
                    size: fileSize,
                    mimeType: mimeType,  // Store the mimeType for later use
                    title: `录制 ${recordings.length + 1}`,  // Default title
                    // Create URL on demand
                    getUrl: function() {
                        if (!this._url) {
                            this._url = URL.createObjectURL(this.blob);
                        }
                        return this._url;
                    }
                };
                
                // Set the global variable for the save button
                recordedVideoUrl = recording.getUrl();
                
                try {
                    // Save to IndexedDB first
                    const recordId = await saveRecordingToDB(recording);
                    // Add the ID to the recording object
                    recording.id = recordId;
                    
                    // 添加新录制到列表的开头
                    recordings.unshift(recording);
                    
                    // Update UI after saving - only add the new recording to the top without full refresh
                    updateRecordingsList(false); // Pass false to avoid full refresh
                    
                    updateStatus('录制已停止', 'stopped');
                    
                    // 删除临时片段
                    try {
                        await deleteTempRecordings(currentRecordingId);
                    } catch (error) {
                        console.error('删除临时录制片段时出错:', error);
                    }
                } catch (error) {
                    console.error('保存录制时出错:', error);
                    updateStatus('录制保存失败: ' + error.message, 'stopped');
                }
            } catch (error) {
                console.error('停止录制时发生错误:', error);
                updateStatus('停止录制出错: ' + error.message, 'stopped');
            }
        };

        // 开始录制
        mediaRecorder.start(5000); // 每5秒生成一个数据块，减少内存压力
        isRecording = true;
        isPaused = false;

        // 更新UI状态
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
        saveBtn.disabled = true;
        updateStatus('正在录制...', 'recording');
        
        // 禁用设置选择器 (only if they exist)
        qualitySelect && (qualitySelect.disabled = true);
        frameRateSelect && (frameRateSelect.disabled = true);
        audioToggle && (audioToggle.disabled = true);
        document.getElementById('micToggle') && (document.getElementById('micToggle').disabled = true);
        document.getElementById('cameraToggle') && (document.getElementById('cameraToggle').disabled = true);
        bitrateSelect && (bitrateSelect.disabled = true);
        durationLimit && (durationLimit.disabled = true);
        autoSaveInterval && (autoSaveInterval.disabled = true);

        // 开始计时器
        startRecordingTimer();
        
        // 开始自动保存计时器
        startAutoSaveTimer();

        // 监听流结束事件
        stream.getVideoTracks()[0].onended = () => {
            stopRecording();
        };

        // 将流显示在预览窗口中
        videoElement.style.display = 'block';
        videoElement.srcObject = stream;
        preview.querySelector('.no-preview').style.display = 'none';

    } catch (error) {
        console.error('录制出错:', error);
        updateStatus('录制出错: ' + error.message, 'stopped');
        // 重置UI状态
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
        saveBtn.disabled = true;
        
        // 启用设置选择器 (only if they exist)
        qualitySelect && (qualitySelect.disabled = false);
        frameRateSelect && (frameRateSelect.disabled = false);
        audioToggle && (audioToggle.disabled = false);
        document.getElementById('micToggle') && (document.getElementById('micToggle').disabled = false);
        document.getElementById('cameraToggle') && (document.getElementById('cameraToggle').disabled = false);
        bitrateSelect && (bitrateSelect.disabled = false);
        durationLimit && (durationLimit.disabled = false);
        autoSaveInterval && (autoSaveInterval.disabled = false);
        
        // 停止计时器
        stopRecordingTimer();
    }
}

// 暂停录制
function pauseRecording() {
    if (!mediaRecorder) return;

    if (isPaused) {
        // 恢复录制
        mediaRecorder.resume();
        isPaused = false;
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i> 暂停录制';
        updateStatus('正在录制...', 'recording');
    } else {
        // 暂停录制
        mediaRecorder.pause();
        isPaused = true;
        pauseBtn.innerHTML = '<i class="fas fa-play"></i> 恢复录制';
        updateStatus('录制已暂停', 'paused');
    }
}

// 停止录制
function stopRecording() {
    if (!mediaRecorder || !isRecording) return;

    // 停止MediaRecorder
    mediaRecorder.stop();
    
    // 停止所有轨道
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    
    // If we were using a camera, stop it too
    if (window.cameraStream) {
        window.cameraStream.getTracks().forEach(track => track.stop());
        window.cameraStream = null;
    }
    
    // Hide camera preview
    const cameraPreview = document.getElementById('cameraPreview');
    if (cameraPreview) {
        cameraPreview.style.display = 'none';
        // Clear the video srcObject inside the cameraPreview div
        const videoElement = cameraPreview.querySelector('video');
        if (videoElement) {
            videoElement.srcObject = null;
        }
    }
    
    // 重置状态
    isRecording = false;
    isPaused = false;
    
    // Preserve scroll position before UI changes
    const scrollPosition = window.scrollY || window.pageYOffset;
    
    // 更新UI
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    saveBtn.disabled = false;
    pauseBtn.innerHTML = '<i class="fas fa-pause"></i> 暂停录制';
    
    // 启用设置选择器 (only if they exist)
    qualitySelect && (qualitySelect.disabled = false);
    frameRateSelect && (frameRateSelect.disabled = false);
    audioToggle && (audioToggle.disabled = false);
    document.getElementById('micToggle') && (document.getElementById('micToggle').disabled = false);
    document.getElementById('cameraToggle') && (document.getElementById('cameraToggle').disabled = false);
    bitrateSelect && (bitrateSelect.disabled = false);
    durationLimit && (durationLimit.disabled = false);
    autoSaveInterval && (autoSaveInterval.disabled = false);
    
    // Restore scroll position after UI changes
    setTimeout(() => {
        window.scrollTo(0, scrollPosition);
    }, 0);
    
    // 停止计时器
    stopRecordingTimer();
    stopAutoSaveTimer();
    
    // 不清空预览，让用户可以看到最后的画面
}

// 保存录制
function saveRecording() {
    // Try to use the global recordedVideoUrl if available (for the currently stopped recording)
    if (recordedVideoUrl) {
        // Simply download with default name
        const a = document.createElement('a');
        a.href = recordedVideoUrl;
        a.download = `recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } else if (recordings.length > 0) {
        // If no global recordedVideoUrl, try to save the last recording from the array
        const lastRecording = recordings[recordings.length - 1];
        if (lastRecording && lastRecording.getUrl) {
            // Use the same download approach as other functions
            const extension = lastRecording.mimeType && lastRecording.mimeType.includes('mp4') ? 'mp4' : 'webm';
            const title = lastRecording.title ? lastRecording.title.replace(/[<>:"/\\|?*]/g, '_') : 'recording'; // Sanitize title
            
            const a = document.createElement('a');
            a.href = lastRecording.getUrl();
            a.download = `${title}-${lastRecording.timestamp.toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else {
            alert('没有可保存的录制文件');
            return;
        }
    } else {
        alert('没有可保存的录制文件');
        return;
    }
}

// 更新状态显示
function updateStatus(text, type) {
    status.innerHTML = `
        <i class="fas ${type === 'recording' ? 'fa-circle' : type === 'paused' ? 'fa-pause-circle' : 'fa-stop-circle'}"></i>
        <span>${text}</span>
    `;
    status.className = 'status-bar status-' + type;
}

// 更新录制列表
function updateRecordingsList(fullRefresh = true) {
    if (fullRefresh) {
        // 保存当前滚动位置
        const scrollPosition = window.scrollY || window.pageYOffset;
        
        recordingsContainer.innerHTML = '';
        
        if (recordings.length === 0) {
            recordingsContainer.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>暂无录制记录</p>
                </div>
            `;
            // 恢复滚动位置
            window.scrollTo(0, scrollPosition);
            return;
        }
        
        // 高效更新：只显示最新的10个录制，其他可以通过滚动加载
        const maxDisplay = 10;
        // 倒序显示（最新的在前面）
        const recordingsToShow = recordings.slice().reverse().slice(0, maxDisplay);
        
        recordingsToShow.forEach((recording, index) => {
            const item = createRecordingItem(recording, index, recordings.length - 1 - index);
            recordingsContainer.appendChild(item);
        });
        
        // 如果还有更多录制，显示加载更多按钮
        if (recordings.length > maxDisplay) {
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'btn btn-primary';
            loadMoreBtn.style.margin = '10px auto';
            loadMoreBtn.style.display = 'block';
            loadMoreBtn.innerHTML = `<i class="fas fa-plus"></i> 显示更多录制 (${recordings.length - maxDisplay} 个隐藏)`;
            
            const allRecordings = recordings.slice().reverse(); // 完整的倒序列表
            const hiddenRecordings = allRecordings.slice(maxDisplay); // 隐藏的部分
            
            // 创建一个标志来跟踪是否已经加载了更多
            let moreLoaded = false;
            
            loadMoreBtn.onclick = () => {
                if (!moreLoaded) {
                    // 添加隐藏的录制到当前列表
                    hiddenRecordings.forEach((recording, hiddenIndex) => {
                        const globalIndex = maxDisplay + hiddenIndex;
                        const item = createRecordingItem(recording, globalIndex, recordings.length - 1 - globalIndex);
                        recordingsContainer.appendChild(item);
                    });
                    
                    // 隐藏加载更多按钮
                    loadMoreBtn.style.display = 'none';
                    moreLoaded = true;
                }
            };
            
            recordingsContainer.appendChild(loadMoreBtn);
        }
        
        // 恢复滚动位置
        window.scrollTo(0, scrollPosition);
    } else {
        // Partial update: only add the new recording to the top
        if (recordings.length > 0) {
            // Get the newest recording (first in the array since we used unshift)
            const newRecording = recordings[0];
            
            const item = createRecordingItem(newRecording, 0, 0, true); // Pass true to indicate it's the newest
            
            // Insert the new item at the beginning of the container
            if (recordingsContainer.firstChild && recordingsContainer.firstChild.className === 'empty-state') {
                // If it's an empty state, replace it completely
                recordingsContainer.innerHTML = '';
                recordingsContainer.appendChild(item);
            } else {
                // Otherwise, insert at the beginning
                recordingsContainer.insertBefore(item, recordingsContainer.firstChild);
            }
        }
    }
}

// 创建录制项目元素的辅助函数
function createRecordingItem(recording, displayIndex, arrayIndex, isNewest = false) {
    const item = document.createElement('div');
    item.className = 'recording-item';
    
    const dateStr = recording.timestamp.toLocaleString('zh-CN');
    const durationStr = recording.duration ? formatTime(recording.duration) : '00:00:00';
    const sizeStr = `${(recording.size / (1024 * 1024)).toFixed(2)} MB`;
    
    // 设置视频源 first to get duration
    const video = document.createElement('video');
    video.src = recording.getUrl();
    video.controls = true;
    video.className = 'recording-preview';
    
    // Wait for metadata to load to get the actual duration
    const updateDuration = () => {
        const actualDurationStr = video.duration && video.duration !== Infinity ? 
                                 formatTime(video.duration) : durationStr;
        
        // Create header div
        const headerDiv = document.createElement('div');
        headerDiv.className = 'recording-header';
        
        // Create title element
        const recordingTitleElement = document.createElement('div');
        recordingTitleElement.className = 'recording-title';
        recordingTitleElement.contentEditable = true;
        recordingTitleElement.title = "点击编辑标题";
        recordingTitleElement.textContent = recording.title || recording.customTitle || `录制 ${recordings.length - displayIndex}`;
        
        // Add event listeners to title
        recordingTitleElement.addEventListener('blur', function() {
            recording.title = this.textContent;
            recording.customTitle = this.textContent;
            if (typeof saveRecordingTitle === 'function') {
                saveRecordingTitle(recording);
            }
        });
        
        recordingTitleElement.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.blur(); // Save on Enter
            }
        });
        
        // Create date element
        const dateElement = document.createElement('div');
        dateElement.className = 'recording-date';
        dateElement.textContent = dateStr;
        
        // Add elements to header
        headerDiv.appendChild(recordingTitleElement);
        headerDiv.appendChild(dateElement);
        
        // Create info div
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'font-size: 0.85rem; color: #666; margin-bottom: 10px;';
        
        // Add duration and size info
        const durationSpan = document.createElement('span');
        durationSpan.style.marginRight = '15px';
        durationSpan.innerHTML = `<i class="fas fa-clock"></i> ${actualDurationStr}`;
        
        const sizeSpan = document.createElement('span');
        sizeSpan.innerHTML = `<i class="fas fa-file-video"></i> ${sizeStr}`;
        
        infoDiv.appendChild(durationSpan);
        infoDiv.appendChild(sizeSpan);
        
        // Add header and info to item
        item.appendChild(headerDiv);
        item.appendChild(infoDiv);
        
        // 对于第一个录制（最新的）或在部分更新中的新录制，默认显示预览；对于其他录制，需要点击展开
        if (displayIndex === 0 || isNewest) {
            // 第一个录制或最新录制默认显示预览
            item.appendChild(video);
            // 添加隐藏预览的选项
            const previewToggle = document.createElement('div');
            previewToggle.className = 'preview-toggle';
            previewToggle.innerHTML = '<i class="fas fa-compress"></i> 隐藏预览';
            
            let previewVisible = true;
            previewToggle.addEventListener('click', () => {
                if (previewVisible) {
                    video.style.display = 'none';
                    previewToggle.innerHTML = '<i class="fas fa-expand"></i> 显示预览';
                    previewVisible = false;
                } else {
                    video.style.display = 'block';
                    previewToggle.innerHTML = '<i class="fas fa-compress"></i> 隐藏预览';
                    previewVisible = true;
                }
            });
            
            item.appendChild(previewToggle);
        } else {
            // 其他录制默认不显示预览，需要点击展开
            const previewToggle = document.createElement('div');
            previewToggle.className = 'preview-toggle';
            previewToggle.innerHTML = '<i class="fas fa-expand"></i> 显示预览';
            
            let previewVisible = false;
            previewToggle.addEventListener('click', () => {
                if (!previewVisible) {
                    item.appendChild(video);
                    video.style.display = 'block';
                    previewToggle.innerHTML = '<i class="fas fa-compress"></i> 隐藏预览';
                    previewVisible = true;
                } else {
                    video.style.display = 'none';
                    // 从DOM中移除视频元素以节省内存
                    if (video.parentNode) {
                        item.removeChild(video);
                    }
                    previewToggle.innerHTML = '<i class="fas fa-expand"></i> 显示预览';
                    previewVisible = false;
                }
            });
            
            item.appendChild(previewToggle);
        }
        
        // Create action buttons
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'recording-actions';
        
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'action-btn download-btn';
        downloadBtn.innerHTML = '<i class="fas fa-download"></i> 下载';
        downloadBtn.onclick = () => downloadRecording(arrayIndex);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i> 删除';
        deleteBtn.onclick = () => deleteRecording(arrayIndex);
        
        actionsDiv.appendChild(downloadBtn);
        actionsDiv.appendChild(deleteBtn);
        
        item.appendChild(actionsDiv);
    };
    
    if (video.readyState >= 1) { // Metadata already loaded
        updateDuration();
    } else {
        video.addEventListener('loadedmetadata', updateDuration);
    }
    
    return item;
}

// 下载指定录制
function downloadRecording(index) {
    // Since recordings are in reverse order in the UI compared to the array, 
    // we need to calculate the actual index in the recordings array
    const actualIndex = recordings.length - 1 - index;
    
    if (actualIndex < 0 || actualIndex >= recordings.length) return;
    
    const recording = recordings[actualIndex];
    
    // Check if recording has a valid blob and timestamp
    if (!recording || !recording.timestamp) {
        alert('没有找到要下载的录制文件');
        return;
    }
    
    // Use the same download approach as in the saveRecording function
    const extension = recording.mimeType && recording.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const title = recording.title ? recording.title.replace(/[<>:"/\\|?*]/g, '_') : 'recording'; // Sanitize title

    const a = document.createElement('a');
    a.href = recording.getUrl();
    a.download = `${title}-${recording.timestamp.toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Make the function globally accessible
window.downloadRecording = downloadRecording;

// 删除指定录制
async function deleteRecording(index) {
    // Since recordings are in reverse order in the UI compared to the array, 
    // we need to calculate the actual index in the recordings array
    const actualIndex = recordings.length - 1 - index;
    
    if (actualIndex < 0 || actualIndex >= recordings.length) return;
    
    const recording = recordings[actualIndex];
    
    // 释放URL对象 if it exists
    if (recording._url) {
        URL.revokeObjectURL(recording._url);
        recording._url = null;
    }
    
    // 从IndexedDB删除
    if (recording.id) {
        try {
            await deleteRecordingFromDB(recording.id);
        } catch (error) {
            console.error('从数据库删除录制时出错:', error);
        }
    }
    
    // 从数组中移除
    recordings.splice(actualIndex, 1);
    
    // 更新列表 - need full refresh after deletion to maintain proper ordering
    updateRecordingsList();
}

// 全局访问的删除函数
window.deleteRecording = deleteRecording;

// 全局访问的保存录制标题函数
window.saveRecordingTitle = saveRecordingTitle;

// 全局访问的创建录制项目函数
window.createRecordingItem = createRecordingItem;

// Page load initialization
document.addEventListener('DOMContentLoaded', async () => {
    // 检查浏览器是否支持录屏功能
    const support = checkScreenRecordingSupport();
    
    if (!support.canRecord) {
        showDetailedErrorMessage();
        startBtn.disabled = true;
        return;
    }
    
    // 从IndexedDB加载录制记录
    try {
        recordings = await loadRecordingsFromDB();
        updateRecordingsList();
    } catch (error) {
        console.error('加载录制记录时出错:', error);
        // Initialize with empty array if loading fails
        recordings = [];
        updateRecordingsList();
    }
    
    // 检查是否有未完成的录制（页面刷新恢复）
    try {
        // 这里我们简化处理，实际应用中可能需要更复杂的恢复逻辑
        console.log('检查临时录制数据...');
    } catch (error) {
        console.warn('检查临时录制数据时出错:', error);
    }
    
    // 初始化性能监控
    initPerformanceMonitoring();
});

// Save updated recording title to database
async function saveRecordingTitle(recording) {
    try {
        if (!recording.id) {
            console.error('Recording does not have an ID to update');
            return;
        }
        
        // Update the recording in the database with the new title
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        // First, we need to get the existing record to update it
        const getRequest = store.get(recording.id);
        
        return new Promise((resolve, reject) => {
            getRequest.onsuccess = () => {
                const record = getRequest.result;
                if (record) {
                    // Update the title
                    record.title = recording.title;
                    record.customTitle = recording.customTitle;
                    
                    // Put the updated record back
                    const putRequest = store.put(record);
                    putRequest.onsuccess = () => {
                        console.log('Recording title updated in database:', recording.title);
                        resolve();
                    };
                    putRequest.onerror = (event) => {
                        console.error('更新录制标题时出错:', event.target.error);
                        reject(event.target.error);
                    };
                } else {
                    console.error('找不到要更新的录制记录:', recording.id);
                    reject(new Error('找不到录制记录'));
                }
            };
            
            getRequest.onerror = (event) => {
                console.error('获取录制记录时出错:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('保存录制标题时出错:', error);
        throw error;
    }
}

// 清理临时录制数据
async function clearTempRecordings() {
    try {
        const db = await openDB();
        const transaction = db.transaction(TEMP_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(TEMP_STORE_NAME);
        store.clear();
    } catch (error) {
        console.warn('清理临时录制数据时出错:', error);
    }
}

// 检查和报告内存使用情况
function checkMemoryUsage() {
    if (performance.memory) {
        const memoryInfo = {
            used: Math.round(performance.memory.usedJSHeapSize / 1048576 * 100) / 100, // MB
            total: Math.round(performance.memory.totalJSHeapSize / 1048576 * 100) / 100, // MB
            limit: Math.round(performance.memory.jsHeapSizeLimit / 1048576 * 100) / 100 // MB
        };
        
        console.log(`内存使用情况: ${memoryInfo.used}MB / ${memoryInfo.limit}MB`);
        return memoryInfo;
    }
    return null;
}

// 定期清理过期的临时记录
function scheduleTempRecordCleanup() {
    // 每小时清理一次超过24小时的临时记录
    setInterval(async () => {
        try {
            const db = await openDB();
            const transaction = db.transaction(TEMP_STORE_NAME, 'readwrite');
            const store = transaction.objectStore(TEMP_STORE_NAME);
            
            // 获取所有临时记录
            const request = store.getAll();
            
            request.onsuccess = () => {
                const records = request.result;
                const now = Date.now();
                const oneDayAgo = now - (24 * 60 * 60 * 1000); // 24小时前
                
                records.forEach(record => {
                    if (record.timestamp && record.timestamp < oneDayAgo) {
                        // 删除超过24小时的临时记录
                        store.delete(record.id);
                        console.log(`删除过期临时记录: ${record.id}`);
                    }
                });
            };
        } catch (error) {
            console.warn('清理过期临时记录时出错:', error);
        }
    }, 60 * 60 * 1000); // 每小时运行一次
}

// 初始化性能监控
function initPerformanceMonitoring() {
    // 定期检查内存使用情况
    setInterval(() => {
        checkMemoryUsage();
    }, 30000); // 每30秒检查一次
    
    // 启动临时文件清理调度
    scheduleTempRecordCleanup();
}

// 窗口大小调整时优化布局
window.addEventListener('resize', () => {
    // 确保视频元素正确显示
    if (videoElement.srcObject) {
        videoElement.style.display = 'block';
    }
});

// 页面卸载前保存临时数据
window.addEventListener('beforeunload', (event) => {
    if (isRecording) {
        // 请求保存当前数据
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.requestData();
        }
        
        // 显示确认对话框
        event.preventDefault();
        event.returnValue = '录制正在进行中，确定要离开页面吗？';
        return event.returnValue;
    }
});

// 页面隐藏时也触发数据保存（例如切换标签页或最小化窗口）
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isRecording) {
        // 请求保存当前数据
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.requestData();
        }
    }
});

// Convert video to GIF and download
function convertToGifAndDownload(videoUrl) {
    alert('GIF转换需要外部工具支持。当前录制文件将以WebM格式下载，您可以在后期使用视频转换工具将其转换为GIF格式。');
    
    // Fallback to WebM download
    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = `recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}



// Make an element draggable
function makeDraggable(element) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    
    // Get the element's header (or use the element itself as the draggable part)
    const header = element.querySelector('.drag-header') || element;
    
    // Set the element's cursor
    header.style.cursor = 'move';
    
    // Set position to absolute if it's not already
    if (element.style.position !== 'fixed' && element.style.position !== 'absolute') {
        element.style.position = 'absolute';
    }
    
    // Add event listeners
    header.onmousedown = dragMouseDown;
    
    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        // Get the mouse cursor position at startup
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        // Call a function whenever the cursor moves
        document.onmousemove = elementDrag;
    }
    
    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        // Calculate the new cursor position
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        // Set the element's new position
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
    }
    
    function closeDragElement() {
        // Stop moving when mouse button is released
        document.onmouseup = null;
        document.onmousemove = null;
    }
}