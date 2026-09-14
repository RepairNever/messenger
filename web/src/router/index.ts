import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSessionOrchestrator } from '@/composables/useSessionOrchestrator'
import { hasBackendBaseUrl, requiresConfiguredBackendUrl } from '@/services/runtime/backendEndpoint'
import { isUuidTaskRouteValue, taskSlugFromPublicId } from '@/services/taskRoute'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'main',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/tasks',
      name: 'tasks-list',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/tasks/kanban',
      name: 'tasks-kanban',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/tasks/:taskSlug',
      name: 'tasks-card',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
      beforeEnter: (to) => {
        const taskSlug = typeof to.params.taskSlug === 'string' ? to.params.taskSlug : ''
        if (!taskSlug || isUuidTaskRouteValue(taskSlug)) {
          return { name: 'tasks-list' }
        }

        const canonicalTaskSlug = taskSlugFromPublicId(taskSlug)
        if (taskSlug !== canonicalTaskSlug) {
          return {
            name: 'tasks-card',
            params: { taskSlug: canonicalTaskSlug },
            query: to.query,
            hash: to.hash,
            replace: true,
          }
        }

        return true
      },
    },
    {
      path: '/documents',
      name: 'documents-teamspaces',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/documents/teamspaces/:teamspaceId',
      name: 'documents-teamspace',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/documents/search',
      name: 'documents-search',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    // Keep static `/documents/teamspaces/...` before the dynamic document route.
    {
      path: '/documents/:documentId',
      name: 'documents-card',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/dayoffs',
      name: 'dayoffs',
      component: () => import('@/views/MainView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
  ],
})

router.beforeEach(async (to) => {
  if (requiresConfiguredBackendUrl() && !to.meta.public && !hasBackendBaseUrl()) {
    return { name: 'login' }
  }

  if (to.meta.public) return true

  const auth = useAuthStore()
  const isSessionAvailable = () => auth.authState === 'AUTHENTICATED' || auth.authState === 'AUTH_DEGRADED'

  // Already authenticated in memory
  if (!isSessionAvailable()) {
    // Try restoring from persisted refresh token
    if (auth.loadPersistedRefreshToken()) {
      const orchestrator = useSessionOrchestrator()
      const restoreResult = await orchestrator.tryRestoreSession()
      if (restoreResult === 'unauthenticated' && !isSessionAvailable()) {
        return { name: 'login' }
      }
    } else {
      return { name: 'login' }
    }
  }

  // Admin guard
  if (to.meta.requiresAdmin) {
    const role = auth.effectiveRole
    if (role !== 'admin' && role !== 'owner') {
      return { name: 'main' }
    }
  }

  return true
})

export default router
