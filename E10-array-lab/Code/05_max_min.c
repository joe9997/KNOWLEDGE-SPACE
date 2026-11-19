#include <stdio.h>

int main(void)
{
    int a[20];
    int n, i;
    int max, min;
    int maxPos, minPos;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    max = a[0];
    min = a[0];
    maxPos = 0;
    minPos = 0;
    for (i = 1; i < n; i++) {
        if (a[i] > max) {
            max = a[i];
            maxPos = i;
        }
        if (a[i] < min) {
            min = a[i];
            minPos = i;
        }
    }

    printf("最高分 = %d，第 %d 位\n", max, maxPos + 1);
    printf("最低分 = %d，第 %d 位\n", min, minPos + 1);

    return 0;
}
