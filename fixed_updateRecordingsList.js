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
            saveRecordingTitle(recording);
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