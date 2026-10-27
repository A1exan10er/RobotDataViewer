<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import App from './App.vue';
import { language } from './i18n';
import { nativeToken } from './nativeSession';
import { serviceError, serviceState, startServiceWatch, stopServiceWatch, stopService } from './serviceLifecycle';
const zh = computed(() => language.value === 'zh');
const ended = computed(() => ['stopping', 'stopped', 'disconnected'].includes(serviceState.value));
const exit = () => stopService(() => window.confirm(zh.value
  ? '力数据正在计算。取消计算并退出查看器？已保存的完整结果会保留。'
  : 'Force preparation is active. Cancel it and stop the viewer? Completed saved results will be kept.'));
onMounted(startServiceWatch);
onBeforeUnmount(stopServiceWatch);
</script>
<template>
  <div v-if="serviceState === 'running'" class="service-bar" role="status">
    <span><i></i>{{ zh ? '本机服务运行中' : 'Local service running' }}</span>
    <small>{{ zh ? '关闭启动器窗口可停止服务' : 'Close the launcher window to stop the service' }}</small>
    <button v-if="nativeToken" class="button secondary small" @click="exit">{{ zh ? '停止并退出' : 'Stop & Exit' }}</button>
    <small v-else>{{ zh ? '从启动器打开可启用退出控制' : 'Open from the launcher to enable exit controls' }}</small>
    <span v-if="serviceError" role="alert">{{ zh ? '停止请求失败，请重试或关闭启动器。' : 'Stop request failed. Retry or close the launcher.' }}</span>
  </div>
  <main v-if="ended" class="service-ended" role="status">
    <h1>{{ serviceState === 'disconnected' ? (zh ? '与本机服务的连接已断开' : 'Connection to the local service was lost') : (zh ? '查看器已停止' : 'Viewer stopped') }}</h1>
    <p>{{ zh ? '本标签页的播放、相机和计算已停止。已保存的完整结果会保留。' : 'Playback, cameras, and computation in this tab have stopped. Completed saved results are retained.' }}</p>
    <p>{{ zh ? '重新打开 RobotDataViewer 启动器即可继续。现在可以关闭此标签页。' : 'Open the RobotDataViewer launcher to start again. You can close this tab.' }}</p>
  </main>
  <App v-else />
</template>
